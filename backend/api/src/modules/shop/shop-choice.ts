import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { REDIS } from "../../infra/redis.js";
import type { ShopSku } from "./shop-catalog.js";

/**
 * «Выбор игроков» (docs/35-stage4-plan.md, Р162): метка у повторяемого
 * набора, который за 30 суток купило больше всего **разных** игроков. Метка
 * считается по покупкам, а не ставится руками, поэтому всегда правда; ниже
 * порога покупателей её нет — «выбор» двух человек выбором не назовёшь.
 *
 * Разовые наборы не участвуют: стартовый самый выгодный, его берёт почти
 * каждый, и метка на нём ничего бы не говорила.
 */

export const CHOICE_WINDOW_DAYS = 30;
export const CHOICE_CACHE_KEY = "shop:players-choice";
export const CHOICE_CACHE_KEY_TOKEN = Symbol("CHOICE_CACHE_KEY");
/** Час: метка не должна прыгать между открытиями витрины, а счёт по базе — не на каждое открытие. */
export const CHOICE_CACHE_TTL_SEC = 3_600;
const QUERY_TIMEOUT_MS = 3_000;
const DAY_MS = 86_400_000;

/**
 * Набор с «Выбором игроков»: лидер среди повторяемых по числу разных
 * покупателей; ничья — у набора с меньшим `sort`; у лидера меньше `minBuyers`
 * (и нуль покупателей при любом пороге) — метки нет.
 */
export function choiceOf(counts: ReadonlyMap<string, number>, skus: readonly ShopSku[], minBuyers: number): string | null {
  let leader: { sku: ShopSku; buyers: number } | null = null;
  for (const sku of skus) {
    if (sku.once) continue;
    const buyers = counts.get(sku.id) ?? 0;
    if (buyers === 0) continue;
    if (leader === null || buyers > leader.buyers || (buyers === leader.buyers && sku.sort < leader.sku.sort)) leader = { sku, buyers };
  }
  return leader !== null && leader.buyers >= minBuyers ? leader.sku.id : null;
}

const rowsSchema = z.array(z.object({ sku: z.string(), buyers: z.coerce.number().int().min(0) }));
const cacheSchema = z.record(z.string(), z.number().int().min(0));

type CacheClient = Pick<Redis, "get" | "set">;

@Injectable()
export class ShopChoice {
  private readonly logger = new Logger("shop-choice");

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: CacheClient,
    // Ключ задаёт только тест, чтобы не делить кеш с соседями по базе.
    @Optional() @Inject(CHOICE_CACHE_KEY_TOKEN) private readonly cacheKey: string = CHOICE_CACHE_KEY,
  ) {}

  /**
   * Сколько разных игроков купило набор за 30 суток до `at`. Сбой кеша или
   * базы — пустой счёт, то есть метки нет: витрина без метки работает, а
   * ждать из-за неё нельзя.
   */
  async counts(at: Date = new Date()): Promise<ReadonlyMap<string, number>> {
    try {
      const cached = await this.redis.get(this.cacheKey);
      if (cached !== null) return new Map(Object.entries(cacheSchema.parse(JSON.parse(cached))));
      const fresh = await withTimeout(this.query(at), QUERY_TIMEOUT_MS, "выбор игроков");
      await this.redis.set(this.cacheKey, JSON.stringify(Object.fromEntries(fresh)), "EX", CHOICE_CACHE_TTL_SEC);
      return fresh;
    } catch (error: unknown) {
      this.logger.warn(`счёт покупателей недоступен, метки не будет: ${error instanceof Error ? error.message : String(error)}`);
      return new Map();
    }
  }

  /** Живые оплаты товаров магазина без возврата и без заказанного возврата, один игрок — одна единица. */
  private async query(at: Date): Promise<Map<string, number>> {
    const since = new Date(at.getTime() - CHOICE_WINDOW_DAYS * DAY_MS);
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(QUERY_TIMEOUT_MS)}, true)`;
      return await tx.$queryRaw`
        SELECT sku, COUNT(DISTINCT account_id)::int AS buyers
        FROM purchase
        WHERE product = 'shop_item'::"PurchaseProduct"
          AND mode = 'live'::"PaymentMode"
          AND sku IS NOT NULL
          AND paid_at IS NOT NULL AND paid_at >= ${since} AND paid_at <= ${at}
          AND refunded_at IS NULL AND refund_requested_at IS NULL
          AND status = 'paid'::"PurchaseStatus"
        GROUP BY sku`;
    });
    return new Map(rowsSchema.parse(rows).map((row) => [row.sku, row.buyers]));
  }
}
