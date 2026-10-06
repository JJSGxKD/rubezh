import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PROMO_LIMITS, type PromoInput, type PromoProblem, type PromoRow } from "./shop-promo-rules.js";

/**
 * Акции магазина в базе (`shop_promo`). Проверка соседних акций товара и
 * вставка — под одной блокировкой товара: две вкладки панели не заведут
 * пересекающиеся акции, проверив друг друга до вставки.
 */

export const SHOP_PROMO_REPOSITORY = Symbol("SHOP_PROMO_REPOSITORY");

export interface ShopPromoRepository {
  /** не снятые акции, которые идут в `at` или начнутся до `until` */
  current(at: Date, until: Date): Promise<PromoRow[]>;
  /** все акции для панели, поздние первыми */
  list(limit: number): Promise<PromoRow[]>;
  /**
   * Завести, если `check` не нашёл помехи среди акций того же товара рядом по
   * времени; иначе — помеха, и ничего не записано.
   */
  create(promo: PromoInput & { promoId: string; createdBy: string }, at: Date, check: (nearby: PromoRow[]) => PromoProblem | null): Promise<PromoProblem | null>;
  /** снять идущую или будущую акцию; `null` — нет такой или уже кончилась или снята */
  cancel(promoId: string, actorAccountId: string, at: Date): Promise<PromoRow | null>;
}

const rowSchema = z.object({
  promo_id: z.string(),
  sku: z.string(),
  percent: z.number().int(),
  starts_at: z.date(),
  ends_at: z.date(),
  title: z.string().nullable(),
  created_at: z.date(),
  created_by: z.string(),
  cancelled_at: z.date().nullable(),
  cancelled_by: z.string().nullable(),
});

const COLUMNS = "promo_id::text, sku, percent, starts_at, ends_at, title, created_at, created_by::text, cancelled_at, cancelled_by::text";
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;
const REST_MS = PROMO_LIMITS.restDays * 24 * 3_600_000;

function toRow(raw: unknown): PromoRow {
  const row = rowSchema.parse(raw);
  return {
    promoId: row.promo_id,
    sku: row.sku,
    percent: row.percent,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    title: row.title,
    createdAt: row.created_at,
    createdBy: row.created_by,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
  };
}

@Injectable()
export class PrismaShopPromoRepository implements ShopPromoRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async current(at: Date, until: Date): Promise<PromoRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT ${COLUMNS} FROM shop_promo WHERE cancelled_at IS NULL AND ends_at > $1 AND starts_at < $2 ORDER BY starts_at`,
      at,
      until,
    );
    return rows.map(toRow);
  }

  async list(limit: number): Promise<PromoRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<unknown[]>(`SELECT ${COLUMNS} FROM shop_promo ORDER BY starts_at DESC LIMIT $1`, limit);
    return rows.map(toRow);
  }

  async create(promo: PromoInput & { promoId: string; createdBy: string }, at: Date, check: (nearby: PromoRow[]) => PromoProblem | null): Promise<PromoProblem | null> {
    return await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop_promo:${promo.sku}`}))`;
      // Конец по сроку не раньше фактического, поэтому выборка по нему — с запасом; точное решение — за правилами.
      const nearby = await tx.$queryRawUnsafe<unknown[]>(
        `SELECT ${COLUMNS} FROM shop_promo WHERE sku = $1 AND ends_at > $2 AND starts_at < $3`,
        promo.sku,
        new Date(promo.startsAt.getTime() - REST_MS),
        new Date(promo.endsAt.getTime() + REST_MS),
      );
      const problem = check(nearby.map(toRow));
      if (problem !== null) return problem;
      await tx.$executeRaw`
        INSERT INTO shop_promo (promo_id, sku, percent, starts_at, ends_at, title, created_at, created_by)
        VALUES (${promo.promoId}::uuid, ${promo.sku}, ${promo.percent}, ${promo.startsAt}, ${promo.endsAt}, ${promo.title}, ${at}, ${promo.createdBy}::uuid)`;
      return null;
    }, TX_OPTIONS);
  }

  async cancel(promoId: string, actorAccountId: string, at: Date): Promise<PromoRow | null> {
    const [raw] = await this.prisma.$queryRawUnsafe<unknown[]>(
      `UPDATE shop_promo SET cancelled_at = $2, cancelled_by = $3::uuid
       WHERE promo_id = $1::uuid AND cancelled_at IS NULL AND ends_at > $2
       RETURNING ${COLUMNS}`,
      promoId,
      at,
      actorAccountId,
    );
    return raw === undefined ? null : toRow(raw);
  }
}
