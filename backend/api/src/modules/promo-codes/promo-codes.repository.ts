import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { lockSourceSlot } from "../attribution/source-slot.js";
import { PROMO_KINDS, promoRewardSchema, type PromoCampaignRow, type PromoCampaignUpdate, type PromoReward } from "./promo-code-rules.js";

/**
 * Промокоды в базе: кампании (`promo_campaign`), коды (`promo_code`) и
 * погашения (`promo_redemption`).
 *
 * Погашение — одна транзакция: запись «игрок активировал кампанию»
 * (первичный ключ не даст второй), занятие одноразового кода и счётчик
 * кампании под её лимитом. Два нажатия разом, две вкладки и последний код
 * пачки, введённый двумя игроками одновременно, решает база, а не порядок
 * запросов.
 */

export const PROMO_CODES_REPOSITORY = Symbol("PROMO_CODES_REPOSITORY");

export interface PromoCodeDraft {
  code: string;
  display: string;
}

export type NewPromoCampaign = Omit<PromoCampaignRow, "redeemed" | "pausedAt" | "updatedAt" | "codeSample" | "partnerName">;

export interface CodeLookup {
  code: string;
  display: string;
  redeemedBy: string | null;
  campaign: PromoCampaignRow;
}

export type CreateOutcome = { status: "created"; row: PromoCampaignRow } | { status: "taken"; display: string; title: string };
export type UpdateOutcome = { status: "updated"; before: PromoCampaignRow; after: PromoCampaignRow } | { status: "missing" } | { status: "invalid"; message: string };
export type RemoveOutcome = { status: "removed"; row: PromoCampaignRow } | { status: "missing" } | { status: "used"; redeemed: number };
/**
 * `redeemed` — активировано, `bound` — игрок заодно привязан к партнёру кода;
 * `already` — игрок уже активировал эту кампанию; `used` — одноразовый код
 * занят; `exhausted` — лимит кампании исчерпан.
 */
export type RedeemOutcome = { status: "redeemed"; bound: boolean } | { status: "already" | "used" | "exhausted" };

export interface PromoCodesRepository {
  /** кампании для панели, новые первыми */
  list(limit: number): Promise<PromoCampaignRow[]>;
  byId(campaignId: string): Promise<PromoCampaignRow | null>;
  /** чей это код — для проверки в мастере панели */
  codeOwner(key: string): Promise<{ display: string; title: string } | null>;
  /**
   * Завести кампанию с кодами. Код, занятый другой кампанией, у общего кода —
   * отказ без записи; у пачки — повод выпустить замену из `refill`.
   */
  create(campaign: NewPromoCampaign, codes: readonly PromoCodeDraft[], refill: ((count: number) => PromoCodeDraft[]) | null): Promise<CreateOutcome>;
  /** правка под блокировкой строки: `check` видит то, что в базе сейчас */
  update(campaignId: string, update: PromoCampaignUpdate, at: Date, check: (current: PromoCampaignRow) => string | null): Promise<UpdateOutcome>;
  /** `pausedAt = null` — снять паузу; `null` — кампании нет */
  setPaused(campaignId: string, pausedAt: Date | null, at: Date): Promise<PromoCampaignRow | null>;
  /** удалить можно только кампанию без погашений */
  remove(campaignId: string): Promise<RemoveOutcome>;
  /** коды пачки — для выгрузки списком */
  codes(campaignId: string, limit: number): Promise<{ display: string; redeemedAt: Date | null }[]>;
  /** активации по игровым суткам с `since` */
  daily(campaignId: string, since: Date): Promise<{ day: string; count: number }[]>;
  lookup(key: string): Promise<CodeLookup | null>;
  redemption(campaignId: string, accountId: string): Promise<{ rewardedAt: Date | null } | null>;
  /**
   * Активировать. `partnerId` — к кому привязать игрока, если слот
   * источника свободен (docs/23-referral-and-partner-program.md §5);
   * `null` — не привязывать: код не партнёрский или игрок не новичок.
   */
  redeem(input: { campaignId: string; accountId: string; code: string; batch: boolean; partnerId: string | null; at: Date }): Promise<RedeemOutcome>;
  markRewarded(campaignId: string, accountId: string, credited: PromoReward, at: Date): Promise<void>;
}

const rowSchema = z.object({
  campaign_id: z.string(),
  title: z.string(),
  kind: z.enum(PROMO_KINDS),
  reward: promoRewardSchema,
  message: z.string().nullable(),
  max_redemptions: z.number().int().nullable(),
  redeemed: z.number().int(),
  starts_at: z.date(),
  ends_at: z.date().nullable(),
  new_players_days: z.number().int().nullable(),
  platforms: z.array(z.enum(PLATFORM_IDS)),
  paused_at: z.date().nullable(),
  note: z.string().nullable(),
  created_by: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
  code_sample: z.string().nullable(),
  partner_id: z.string().nullable(),
  partner_name: z.string().nullable(),
});

const COLUMNS = Prisma.sql`c.campaign_id::text, c.title, c.kind, c.reward, c.message, c.max_redemptions, c.redeemed, c.starts_at, c.ends_at,
  c.new_players_days, c.platforms::text[] AS platforms, c.paused_at, c.note, c.created_by::text, c.created_at, c.updated_at,
  (SELECT p.display FROM promo_code p WHERE p.campaign_id = c.campaign_id ORDER BY p.code LIMIT 1) AS code_sample,
  c.partner_id::text, (SELECT pt.name FROM partner pt WHERE pt.partner_id = c.partner_id) AS partner_name`;

const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;
/** сколько раз выпускать замену кодам пачки, совпавшим с уже занятыми */
const REFILL_ROUNDS = 5;

function toRow(raw: unknown): PromoCampaignRow {
  const row = rowSchema.parse(raw);
  return {
    campaignId: row.campaign_id,
    title: row.title,
    kind: row.kind,
    reward: row.reward,
    message: row.message,
    maxRedemptions: row.max_redemptions,
    redeemed: row.redeemed,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    newPlayersDays: row.new_players_days,
    platforms: row.platforms,
    pausedAt: row.paused_at,
    note: row.note,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    codeSample: row.code_sample ?? "",
  };
}

/** Откат транзакции погашения с причиной: Prisma откатывает её по любому исключению. */
class RedeemRollback extends Error {
  constructor(readonly outcome: "used" | "exhausted") {
    super(outcome);
  }
}

/** Откат заведения кампании: код занят, а замены нет. */
class CodeTaken extends Error {
  constructor(
    readonly display: string,
    readonly title: string,
  ) {
    super("promo_code_taken");
  }
}

const codeRows = z.array(z.object({ code: z.string() }));
const ownerRows = z.array(z.object({ display: z.string(), title: z.string() }));

@Injectable()
export class PrismaPromoCodesRepository implements PromoCodesRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(limit: number): Promise<PromoCampaignRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT ${COLUMNS} FROM promo_campaign c ORDER BY c.created_at DESC LIMIT ${limit}`;
    return rows.map(toRow);
  }

  async byId(campaignId: string): Promise<PromoCampaignRow | null> {
    const [raw] = await this.prisma.$queryRaw<unknown[]>`SELECT ${COLUMNS} FROM promo_campaign c WHERE c.campaign_id = ${campaignId}::uuid`;
    return raw === undefined ? null : toRow(raw);
  }

  async codeOwner(key: string): Promise<{ display: string; title: string } | null> {
    const [raw] = await this.prisma.$queryRaw<unknown[]>`
      SELECT p.display, c.title FROM promo_code p JOIN promo_campaign c ON c.campaign_id = p.campaign_id WHERE p.code = ${key}`;
    const [owner] = ownerRows.parse(raw === undefined ? [] : [raw]);
    return owner ?? null;
  }

  async create(campaign: NewPromoCampaign, codes: readonly PromoCodeDraft[], refill: ((count: number) => PromoCodeDraft[]) | null): Promise<CreateOutcome> {
    return await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO promo_campaign (campaign_id, title, kind, reward, message, max_redemptions, starts_at, ends_at, new_players_days, platforms, note,
                                    partner_id, created_by, created_at, updated_at)
        VALUES (${campaign.campaignId}::uuid, ${campaign.title}, ${campaign.kind}, ${JSON.stringify(campaign.reward)}::jsonb, ${campaign.message},
                ${campaign.maxRedemptions}, ${campaign.startsAt}, ${campaign.endsAt}, ${campaign.newPlayersDays}, ${campaign.platforms}::varchar(16)[],
                ${campaign.note}, ${campaign.partnerId}::uuid, ${campaign.createdBy}::uuid, ${campaign.createdAt}, ${campaign.createdAt})`;

      let pending = [...codes];
      for (let round = 0; pending.length > 0; round += 1) {
        const inserted = codeRows.parse(
          await tx.$queryRaw<unknown[]>`
          INSERT INTO promo_code (code, display, campaign_id)
          SELECT u.code, u.display, ${campaign.campaignId}::uuid FROM unnest(${pending.map((draft) => draft.code)}::text[], ${pending.map((draft) => draft.display)}::text[]) AS u(code, display)
          ON CONFLICT (code) DO NOTHING
          RETURNING code`,
        );
        const done = new Set(inserted.map((row) => row.code));
        const clashed = pending.filter((draft) => !done.has(draft.code));
        if (clashed.length === 0) break;
        if (refill === null || round >= REFILL_ROUNDS) {
          const first = clashed[0] ?? pending[0];
          const [owner] = ownerRows.parse(
            await tx.$queryRaw<unknown[]>`
              SELECT p.display, c.title FROM promo_code p JOIN promo_campaign c ON c.campaign_id = p.campaign_id WHERE p.code = ${first?.code ?? ""}`,
          );
          // Откат: кампания без своих кодов не нужна никому.
          throw new CodeTaken(owner?.display ?? first?.display ?? "", owner?.title ?? "");
        }
        pending = refill(clashed.length);
      }
      const [raw] = await tx.$queryRaw<unknown[]>`SELECT ${COLUMNS} FROM promo_campaign c WHERE c.campaign_id = ${campaign.campaignId}::uuid`;
      return { status: "created" as const, row: toRow(raw) };
    }, TX_OPTIONS).catch((error: unknown) => {
      if (error instanceof CodeTaken) return { status: "taken" as const, display: error.display, title: error.title };
      throw error;
    });
  }

  async update(campaignId: string, update: PromoCampaignUpdate, at: Date, check: (current: PromoCampaignRow) => string | null): Promise<UpdateOutcome> {
    return await this.prisma.$transaction(async (tx): Promise<UpdateOutcome> => {
      const [raw] = await tx.$queryRaw<unknown[]>`SELECT ${COLUMNS} FROM promo_campaign c WHERE c.campaign_id = ${campaignId}::uuid FOR UPDATE OF c`;
      if (raw === undefined) return { status: "missing" };
      const before = toRow(raw);
      const problem = check(before);
      if (problem !== null) return { status: "invalid", message: problem };
      await tx.$executeRaw`
        UPDATE promo_campaign SET title = ${update.title}, note = ${update.note}, message = ${update.message}, reward = ${JSON.stringify(update.reward)}::jsonb,
               max_redemptions = ${update.maxRedemptions}, starts_at = ${update.startsAt}, ends_at = ${update.endsAt},
               new_players_days = ${update.newPlayersDays}, platforms = ${update.platforms}::varchar(16)[], updated_at = ${at}
        WHERE campaign_id = ${campaignId}::uuid`;
      const [next] = await tx.$queryRaw<unknown[]>`SELECT ${COLUMNS} FROM promo_campaign c WHERE c.campaign_id = ${campaignId}::uuid`;
      return { status: "updated", before, after: toRow(next) };
    }, TX_OPTIONS);
  }

  async setPaused(campaignId: string, pausedAt: Date | null, at: Date): Promise<PromoCampaignRow | null> {
    const updated = await this.prisma.$executeRaw`
      UPDATE promo_campaign SET paused_at = ${pausedAt}, updated_at = ${at} WHERE campaign_id = ${campaignId}::uuid`;
    return updated === 0 ? null : await this.byId(campaignId);
  }

  async remove(campaignId: string): Promise<RemoveOutcome> {
    return await this.prisma.$transaction(async (tx): Promise<RemoveOutcome> => {
      const [raw] = await tx.$queryRaw<unknown[]>`SELECT ${COLUMNS} FROM promo_campaign c WHERE c.campaign_id = ${campaignId}::uuid FOR UPDATE OF c`;
      if (raw === undefined) return { status: "missing" };
      const row = toRow(raw);
      // Счётчик кампании и строки погашений меняются в одной транзакции, а
      // внешний ключ погашений не даст удалить кампанию и мимо этой проверки.
      if (row.redeemed > 0) return { status: "used", redeemed: row.redeemed };
      await tx.$executeRaw`DELETE FROM promo_campaign WHERE campaign_id = ${campaignId}::uuid`;
      return { status: "removed", row };
    }, TX_OPTIONS);
  }

  async codes(campaignId: string, limit: number): Promise<{ display: string; redeemedAt: Date | null }[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT display, redeemed_at FROM promo_code WHERE campaign_id = ${campaignId}::uuid ORDER BY display LIMIT ${limit}`;
    return rows.map((raw) => {
      const row = z.object({ display: z.string(), redeemed_at: z.date().nullable() }).parse(raw);
      return { display: row.display, redeemedAt: row.redeemed_at };
    });
  }

  async daily(campaignId: string, since: Date): Promise<{ day: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT to_char((redeemed_at AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, 'YYYY-MM-DD') AS day, count(*)::int AS count
      FROM promo_redemption WHERE campaign_id = ${campaignId}::uuid AND redeemed_at >= ${since}
      GROUP BY 1 ORDER BY 1`;
    return rows.map((raw) => z.object({ day: z.string(), count: z.number().int() }).parse(raw));
  }

  async lookup(key: string): Promise<CodeLookup | null> {
    const [raw] = await this.prisma.$queryRaw<unknown[]>`SELECT code, display, campaign_id::text, redeemed_by::text FROM promo_code WHERE code = ${key}`;
    if (raw === undefined) return null;
    const code = z.object({ code: z.string(), display: z.string(), campaign_id: z.string(), redeemed_by: z.string().nullable() }).parse(raw);
    const campaign = await this.byId(code.campaign_id);
    return campaign === null ? null : { code: code.code, display: code.display, redeemedBy: code.redeemed_by, campaign };
  }

  async redemption(campaignId: string, accountId: string): Promise<{ rewardedAt: Date | null } | null> {
    const [raw] = await this.prisma.$queryRaw<unknown[]>`
      SELECT rewarded_at FROM promo_redemption WHERE campaign_id = ${campaignId}::uuid AND account_id = ${accountId}::uuid`;
    return raw === undefined ? null : { rewardedAt: z.object({ rewarded_at: z.date().nullable() }).parse(raw).rewarded_at };
  }

  async redeem(input: { campaignId: string; accountId: string; code: string; batch: boolean; partnerId: string | null; at: Date }): Promise<RedeemOutcome> {
    return await this.prisma
      .$transaction(async (tx): Promise<RedeemOutcome> => {
        const fresh = await tx.$executeRaw`
          INSERT INTO promo_redemption (campaign_id, account_id, code, redeemed_at)
          VALUES (${input.campaignId}::uuid, ${input.accountId}::uuid, ${input.code}, ${input.at})
          ON CONFLICT (campaign_id, account_id) DO NOTHING`;
        if (fresh === 0) return { status: "already" };
        if (input.batch) {
          const taken = await tx.$executeRaw`
            UPDATE promo_code SET redeemed_by = ${input.accountId}::uuid, redeemed_at = ${input.at}
            WHERE code = ${input.code} AND redeemed_by IS NULL`;
          if (taken === 0) throw new RedeemRollback("used");
        }
        const counted = await tx.$executeRaw`
          UPDATE promo_campaign SET redeemed = redeemed + 1
          WHERE campaign_id = ${input.campaignId}::uuid AND (max_redemptions IS NULL OR redeemed < max_redemptions)`;
        if (counted === 0) throw new RedeemRollback("exhausted");
        // Привязка — в той же транзакции: активированный код партнёра без
        // привязки или привязка без активации считались бы по-разному.
        let bound = false;
        if (input.partnerId !== null && (await lockSourceSlot(tx, input.accountId)) === "free") {
          bound =
            (await tx.$executeRaw`
              INSERT INTO partner_binding (account_id, partner_id, campaign_id, bound_at)
              VALUES (${input.accountId}::uuid, ${input.partnerId}::uuid, ${input.campaignId}::uuid, ${input.at})
              ON CONFLICT (account_id) DO NOTHING`) > 0;
        }
        return { status: "redeemed", bound };
      }, TX_OPTIONS)
      .catch((error: unknown) => {
        if (error instanceof RedeemRollback) return { status: error.outcome };
        throw error;
      });
  }

  async markRewarded(campaignId: string, accountId: string, credited: PromoReward, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE promo_redemption SET rewarded_at = ${at}, credited = ${JSON.stringify(credited)}::jsonb
      WHERE campaign_id = ${campaignId}::uuid AND account_id = ${accountId}::uuid AND rewarded_at IS NULL`;
  }
}
