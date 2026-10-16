import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PartnerTelegramTakenError } from "./partner-errors.js";
import { PARTNER_STATUSES, type PartnerPatch, type PartnerRow, type PartnerStats } from "./partner-rules.js";

/**
 * Партнёры в базе (`partner`, `partner_binding`) и то, что они принесли.
 * Статистика считается запросом по привязкам, кодам и оплатам, а не
 * счётчиками: партнёров единицы, а пересчитанное число не разойдётся с
 * оплатами после возврата.
 */

export const PARTNERS_REPOSITORY = Symbol("PARTNERS_REPOSITORY");

export interface PartnerCampaignRow {
  campaignId: string;
  title: string;
  kind: "shared" | "batch";
  codeSample: string;
  redeemed: number;
  maxRedemptions: number | null;
  startsAt: Date;
  endsAt: Date | null;
  pausedAt: Date | null;
  /** сколько игроков привязал этот код */
  bound: number;
}

export interface PartnerBindingView {
  partnerId: string;
  name: string;
  boundAt: Date;
  /** кампания и код, которым привязан; `null` — кампании уже нет */
  campaignTitle: string | null;
  code: string | null;
}

export interface PartnersRepository {
  /** партнёры со статистикой, новые первыми */
  list(limit: number, at: Date): Promise<(PartnerRow & { stats: PartnerStats })[]>;
  byId(partnerId: string, at: Date): Promise<(PartnerRow & { stats: PartnerStats }) | null>;
  /** привязки по игровым суткам с `since` */
  daily(partnerId: string, since: Date): Promise<{ day: string; count: number }[]>;
  campaigns(partnerId: string): Promise<PartnerCampaignRow[]>;
  /** TG id занят другим партнёром — `PartnerTelegramTakenError` с его именем */
  create(partner: PartnerRow): Promise<void>;
  /**
   * Меняет только названные поля — `null` стирает, не названное остаётся. `null` в ответе — партнёра нет;
   * занятый TG id — `PartnerTelegramTakenError`.
   */
  update(partnerId: string, patch: PartnerPatch, at: Date): Promise<{ before: PartnerRow; after: PartnerRow } | null>;
  names(): Promise<{ partnerId: string; name: string }[]>;
  /** к какому партнёру привязан игрок; `null` — ни к какому */
  bindingOf(accountId: string): Promise<PartnerBindingView | null>;
}

const rowSchema = z.object({
  partner_id: z.string(),
  name: z.string(),
  contact: z.string().nullable(),
  note: z.string().nullable(),
  created_by: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
  telegram_id: z.string().nullable(),
  // Статус из базы читается строго: молча принять неизвестный за «активен» значило бы привязывать игроков к тому, кого не звали.
  status: z.enum(PARTNER_STATUSES),
  country: z.string().nullable(),
  payout_currency: z.string().nullable(),
  payout_method: z.string().nullable(),
  share_percent: z.string().nullable(),
});

const statsSchema = z.object({
  codes: z.number().int(),
  active_codes: z.number().int(),
  redeemed: z.number().int(),
  bound: z.number().int(),
  played: z.number().int(),
  payers: z.number().int(),
  stars: z.number().int(),
});

function toRow(raw: unknown): PartnerRow {
  const row = rowSchema.parse(raw);
  return {
    partnerId: row.partner_id,
    name: row.name,
    contact: row.contact,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    telegramId: row.telegram_id,
    status: row.status,
    country: row.country,
    payoutCurrency: row.payout_currency,
    payoutMethod: row.payout_method,
    sharePercent: row.share_percent,
  };
}

function toStats(raw: unknown): PartnerStats {
  const row = statsSchema.parse(raw);
  return { codes: row.codes, activeCodes: row.active_codes, redeemed: row.redeemed, bound: row.bound, played: row.played, payers: row.payers, stars: row.stars };
}

// Процент — текстом: десятичная доля не должна пройти через двоичную дробь.
const COLUMNS = Prisma.sql`p.partner_id::text, p.name, p.contact, p.note, p.created_by::text, p.created_at, p.updated_at,
  p.telegram_id, p.status, p.country, p.payout_currency, p.payout_method, p.share_percent::text AS share_percent`;

/**
 * Колонки, которые правка может менять. Имена — из этой константы, а не из ввода: идентификатор в
 * запрос параметром не передать, поэтому в SQL он идёт готовым, а значение — параметром.
 */
const PATCH_COLUMNS = {
  name: "name",
  contact: "contact",
  note: "note",
  telegramId: "telegram_id",
  status: "status",
  country: "country",
  payoutCurrency: "payout_currency",
  payoutMethod: "payout_method",
  sharePercent: "share_percent",
} as const satisfies Record<keyof PartnerPatch, string>;

/** Нарушение уникальности TG id: код Postgres 23505 приходит то как P2002, то в `meta` сырого запроса. */
function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2002" || JSON.stringify(error.meta ?? {}).includes("23505");
  }
  return error instanceof Error && /23505|duplicate key/i.test(error.message);
}

/**
 * Партнёры со статистикой. Платящие и звёзды — живые оплаты после привязки:
 * то, что игрок купил до кода партнёра, партнёру не засчитывается, а
 * возвращённое (`refunded`) — тоже.
 */
function withStats(at: Date, where: Prisma.Sql, limit: number): Prisma.Sql {
  return Prisma.sql`
    WITH codes AS (
      SELECT partner_id, count(*)::int AS codes,
             count(*) FILTER (WHERE paused_at IS NULL AND starts_at <= ${at} AND (ends_at IS NULL OR ends_at > ${at})
                              AND (max_redemptions IS NULL OR redeemed < max_redemptions))::int AS active_codes,
             coalesce(sum(redeemed), 0)::int AS redeemed
      FROM promo_campaign WHERE partner_id IS NOT NULL GROUP BY partner_id
    ), bound AS (
      SELECT b.partner_id, count(*)::int AS bound, count(f.first_run_finished_at)::int AS played
      FROM partner_binding b LEFT JOIN account_funnel f ON f.account_id = b.account_id
      GROUP BY b.partner_id
    ), paid AS (
      SELECT b.partner_id, count(DISTINCT pu.account_id)::int AS payers, coalesce(sum(pu.charged_stars), 0)::int AS stars
      FROM partner_binding b JOIN purchase pu ON pu.account_id = b.account_id
      WHERE pu.mode = 'live' AND pu.status = 'paid' AND pu.paid_at >= b.bound_at
      GROUP BY b.partner_id
    )
    SELECT ${COLUMNS},
           coalesce(c.codes, 0) AS codes, coalesce(c.active_codes, 0) AS active_codes, coalesce(c.redeemed, 0) AS redeemed,
           coalesce(bd.bound, 0) AS bound, coalesce(bd.played, 0) AS played,
           coalesce(pd.payers, 0) AS payers, coalesce(pd.stars, 0) AS stars
    FROM partner p
    LEFT JOIN codes c ON c.partner_id = p.partner_id
    LEFT JOIN bound bd ON bd.partner_id = p.partner_id
    LEFT JOIN paid pd ON pd.partner_id = p.partner_id
    ${where}
    ORDER BY p.created_at DESC
    LIMIT ${limit}`;
}

@Injectable()
export class PrismaPartnersRepository implements PartnersRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(limit: number, at: Date): Promise<(PartnerRow & { stats: PartnerStats })[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>(withStats(at, Prisma.empty, limit));
    return rows.map((raw) => ({ ...toRow(raw), stats: toStats(raw) }));
  }

  async byId(partnerId: string, at: Date): Promise<(PartnerRow & { stats: PartnerStats }) | null> {
    const [raw] = await this.prisma.$queryRaw<unknown[]>(withStats(at, Prisma.sql`WHERE p.partner_id = ${partnerId}::uuid`, 1));
    return raw === undefined ? null : { ...toRow(raw), stats: toStats(raw) };
  }

  async daily(partnerId: string, since: Date): Promise<{ day: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT to_char((bound_at AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date, 'YYYY-MM-DD') AS day, count(*)::int AS count
      FROM partner_binding WHERE partner_id = ${partnerId}::uuid AND bound_at >= ${since}
      GROUP BY 1 ORDER BY 1`;
    return rows.map((raw) => z.object({ day: z.string(), count: z.number().int() }).parse(raw));
  }

  async campaigns(partnerId: string): Promise<PartnerCampaignRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT c.campaign_id::text, c.title, c.kind, c.redeemed, c.max_redemptions, c.starts_at, c.ends_at, c.paused_at,
             (SELECT pc.display FROM promo_code pc WHERE pc.campaign_id = c.campaign_id ORDER BY pc.code LIMIT 1) AS code_sample,
             (SELECT count(*)::int FROM partner_binding b WHERE b.campaign_id = c.campaign_id) AS bound
      FROM promo_campaign c WHERE c.partner_id = ${partnerId}::uuid
      ORDER BY c.created_at DESC`;
    return rows.map((raw) => {
      const row = z
        .object({
          campaign_id: z.string(),
          title: z.string(),
          kind: z.enum(["shared", "batch"]),
          redeemed: z.number().int(),
          max_redemptions: z.number().int().nullable(),
          starts_at: z.date(),
          ends_at: z.date().nullable(),
          paused_at: z.date().nullable(),
          code_sample: z.string().nullable(),
          bound: z.number().int(),
        })
        .parse(raw);
      return {
        campaignId: row.campaign_id,
        title: row.title,
        kind: row.kind,
        codeSample: row.code_sample ?? "",
        redeemed: row.redeemed,
        maxRedemptions: row.max_redemptions,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        pausedAt: row.paused_at,
        bound: row.bound,
      };
    });
  }

  async create(partner: PartnerRow): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO partner (partner_id, name, contact, note, created_by, created_at, updated_at,
                             telegram_id, status, country, payout_currency, payout_method, share_percent)
        VALUES (${partner.partnerId}::uuid, ${partner.name}, ${partner.contact}, ${partner.note}, ${partner.createdBy}::uuid, ${partner.createdAt}, ${partner.updatedAt},
                ${partner.telegramId ?? null}, ${partner.status ?? "active"}, ${partner.country ?? null}, ${partner.payoutCurrency ?? null},
                ${partner.payoutMethod ?? null}, ${partner.sharePercent ?? null}::numeric)`;
    } catch (error: unknown) {
      throw await this.telegramTaken(error, partner.telegramId ?? null);
    }
  }

  async update(partnerId: string, patch: PartnerPatch, at: Date): Promise<{ before: PartnerRow; after: PartnerRow } | null> {
    // Названные поля — пары «колонка = значение»; не названные (undefined) в запрос не попадают и остаются как были.
    const named = (Object.keys(PATCH_COLUMNS) as (keyof PartnerPatch)[]).filter((key) => patch[key] !== undefined);
    const assignments = named.map((key) => {
      const value = patch[key];
      return key === "sharePercent" ? Prisma.sql`${Prisma.raw(PATCH_COLUMNS[key])} = ${value ?? null}::numeric` : Prisma.sql`${Prisma.raw(PATCH_COLUMNS[key])} = ${value ?? null}`;
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [raw] = await tx.$queryRaw<unknown[]>`SELECT ${COLUMNS} FROM partner p WHERE p.partner_id = ${partnerId}::uuid FOR UPDATE`;
        if (raw === undefined) return null;
        const before = toRow(raw);
        await tx.$executeRaw`UPDATE partner SET ${Prisma.join([...assignments, Prisma.sql`updated_at = ${at}`])} WHERE partner_id = ${partnerId}::uuid`;
        const changes = Object.fromEntries(named.map((key) => [key, patch[key]]));
        return { before, after: { ...before, ...changes, updatedAt: at } };
      });
    } catch (error: unknown) {
      throw await this.telegramTaken(error, patch.telegramId ?? null);
    }
  }

  /** Нарушение уникальности TG id — отказ с именем держателя; прочие ошибки — как были. */
  private async telegramTaken(error: unknown, telegramId: string | null): Promise<unknown> {
    if (telegramId === null || !isUniqueViolation(error)) return error;
    const [holder] = await this.prisma.$queryRaw<{ name: string }[]>`SELECT name FROM partner WHERE telegram_id = ${telegramId} LIMIT 1`;
    return holder === undefined ? error : new PartnerTelegramTakenError(holder.name);
  }

  async names(): Promise<{ partnerId: string; name: string }[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT partner_id::text, name FROM partner ORDER BY name`;
    return rows.map((raw) => {
      const row = z.object({ partner_id: z.string(), name: z.string() }).parse(raw);
      return { partnerId: row.partner_id, name: row.name };
    });
  }

  async bindingOf(accountId: string): Promise<PartnerBindingView | null> {
    const [raw] = await this.prisma.$queryRaw<unknown[]>`
      SELECT b.partner_id::text, p.name, b.bound_at, c.title AS campaign_title, pc.display AS code
      FROM partner_binding b
      JOIN partner p ON p.partner_id = b.partner_id
      LEFT JOIN promo_campaign c ON c.campaign_id = b.campaign_id
      LEFT JOIN promo_redemption r ON r.campaign_id = b.campaign_id AND r.account_id = b.account_id
      LEFT JOIN promo_code pc ON pc.code = r.code
      WHERE b.account_id = ${accountId}::uuid`;
    if (raw === undefined) return null;
    const row = z.object({ partner_id: z.string(), name: z.string(), bound_at: z.date(), campaign_title: z.string().nullable(), code: z.string().nullable() }).parse(raw);
    return { partnerId: row.partner_id, name: row.name, boundAt: row.bound_at, campaignTitle: row.campaign_title, code: row.code };
  }
}
