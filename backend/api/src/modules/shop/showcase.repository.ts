import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { ITEM_RARITIES, ITEM_SLOTS, ITEM_STATS, type ItemRarity, type ItemSlot } from "../items/item-catalog.js";
import type { ItemRolls } from "../items/item-rules.js";

/**
 * Витрина снаряжения в базе (docs/35-stage4-plan.md §3.6, WP10). Игровые
 * сутки считает база — одна граница у всех реплик (`common/game-day.ts`).
 */

export interface ShowcaseRow {
  offerId: string;
  accountId: string;
  /** игровые сутки, `YYYY-MM-DD` */
  gameDay: string;
  position: number;
  slot: ItemSlot;
  rarity: ItemRarity;
  level: number;
  seed: number;
  rolls: ItemRolls;
  priceGems: number;
  soldAt: Date | null;
  itemId: string | null;
}

export type NewShowcaseOffer = Pick<ShowcaseRow, "offerId" | "position" | "slot" | "rarity" | "level" | "seed" | "rolls" | "priceGems">;

export const SHOWCASE_REPOSITORY = Symbol("SHOWCASE_REPOSITORY");

export interface ShowcaseRepository {
  /** витрина игрока на игровые сутки момента `at`; пусто — ещё не выставляли */
  today(accountId: string, at: Date): Promise<{ gameDay: string; offers: ShowcaseRow[] }>;
  /**
   * Выставить витрину суток целиком — или ничего, если её уже выставило
   * параллельное открытие: смесь двух бросков повторила бы слоты.
   */
  fill(accountId: string, gameDay: string, offers: readonly NewShowcaseOffer[], at: Date): Promise<void>;
  byId(accountId: string, offerId: string): Promise<ShowcaseRow | null>;
  /** отметить проданным; `false` — уже отмечено */
  markSold(accountId: string, offerId: string, itemId: string, at: Date): Promise<boolean>;
  /** уровень аккаунта: от него редкости и уровень предметов витрины */
  accountLevel(accountId: string): Promise<number>;
}

const rollsSchema = z.object({
  main: z.object({ stat: z.enum(ITEM_STATS), roll: z.number() }),
  extras: z.array(z.object({ stat: z.enum(ITEM_STATS), roll: z.number() })),
});

const rowSchema = z.object({
  offer_id: z.string(),
  account_id: z.string(),
  game_day: z.string(),
  position: z.number().int(),
  slot: z.enum(ITEM_SLOTS),
  rarity: z.enum(ITEM_RARITIES),
  level: z.number().int(),
  seed: z.bigint(),
  rolls: rollsSchema,
  price_gems: z.number().int(),
  sold_at: z.date().nullable(),
  item_id: z.string().nullable(),
});

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

const COLUMNS = "offer_id::text, account_id::text, game_day::text, position, slot::text, rarity::text, level, seed, rolls, price_gems, sold_at, item_id::text";

function toRow(raw: unknown): ShowcaseRow {
  const row = rowSchema.parse(raw);
  return {
    offerId: row.offer_id,
    accountId: row.account_id,
    gameDay: row.game_day,
    position: row.position,
    slot: row.slot,
    rarity: row.rarity,
    level: row.level,
    seed: Number(row.seed),
    rolls: row.rolls,
    priceGems: row.price_gems,
    soldAt: row.sold_at,
    itemId: row.item_id,
  };
}

@Injectable()
export class PrismaShowcaseRepository implements ShowcaseRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async today(accountId: string, at: Date): Promise<{ gameDay: string; offers: ShowcaseRow[] }> {
    const [day] = await this.prisma.$queryRaw<{ game_day: string }[]>`
      SELECT ((${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date)::text AS game_day`;
    const gameDay = z.string().parse(day?.game_day);
    const rows = await this.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT ${COLUMNS} FROM showcase_offer WHERE account_id = $1::uuid AND game_day = $2::date ORDER BY position`,
      accountId,
      gameDay,
    );
    return { gameDay, offers: rows.map(toRow) };
  }

  async fill(accountId: string, gameDay: string, offers: readonly NewShowcaseOffer[], at: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`showcase:${accountId}`}))`;
      const [placed] = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM showcase_offer WHERE account_id = ${accountId}::uuid AND game_day = ${gameDay}::date`;
      if (Number(placed?.n ?? 0n) > 0) return;
      for (const offer of offers) {
        await tx.$executeRaw`
          INSERT INTO showcase_offer (offer_id, account_id, game_day, position, slot, rarity, level, seed, rolls, price_gems, created_at)
          VALUES (${offer.offerId}::uuid, ${accountId}::uuid, ${gameDay}::date, ${offer.position}, ${offer.slot}::"ItemSlot", ${offer.rarity}::"ItemRarity",
                  ${offer.level}, ${offer.seed}, ${JSON.stringify(offer.rolls)}::jsonb, ${offer.priceGems}, ${at})`;
      }
    }, TX_OPTIONS);
  }

  async byId(accountId: string, offerId: string): Promise<ShowcaseRow | null> {
    const [raw] = await this.prisma.$queryRawUnsafe<unknown[]>(`SELECT ${COLUMNS} FROM showcase_offer WHERE offer_id = $1::uuid AND account_id = $2::uuid`, offerId, accountId);
    return raw === undefined ? null : toRow(raw);
  }

  async markSold(accountId: string, offerId: string, itemId: string, at: Date): Promise<boolean> {
    return (
      (await this.prisma.$executeRaw`
        UPDATE showcase_offer SET sold_at = ${at}, item_id = ${itemId}::uuid
        WHERE offer_id = ${offerId}::uuid AND account_id = ${accountId}::uuid AND sold_at IS NULL`) > 0
    );
  }

  async accountLevel(accountId: string): Promise<number> {
    const [progress] = await this.prisma.$queryRaw<{ level: number }[]>`SELECT level FROM account_progress WHERE account_id = ${accountId}::uuid`;
    return progress?.level ?? 1;
  }
}
