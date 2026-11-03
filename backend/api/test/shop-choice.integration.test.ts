import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { closeRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { ShopChoice } from "../src/modules/shop/shop-choice.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * «Выбор игроков» на живых Postgres и Redis (docs/17-testing-strategy.md
 * §4.2; адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них
 * пропуск): считаются разные игроки, а не покупки; старые, возвращённые и
 * тестовые оплаты не в счёте; второй запрос — из кеша.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 14);
const live = DATABASE_URL !== "" && REDIS_URL !== "";
const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 9, 28, 12));

describe.skipIf(!live)("выбор игроков на живых Postgres и Redis", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  // Свой ключ кеша: общий `shop:players-choice` на тестовой базе принадлежит не этому файлу.
  const cacheKey = `test:shop-choice:${randomUUID()}`;

  async function player(): Promise<string> {
    const platformUserId = String(950_000_000 + Math.floor(Math.random() * 30_000_000));
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Покупатель", username: null }, Date.now());
    return created.accountId;
  }

  async function buy(accountId: string, sku: string, patch: { paidAt?: Date; mode?: "live" | "test"; refundRequestedAt?: Date; refundedAt?: Date; product?: "shop_item" | "continue_run" } = {}): Promise<void> {
    const refunded = patch.refundedAt !== undefined;
    await prisma.purchase.create({
      data: {
        purchaseId: randomUUID(),
        accountId,
        product: patch.product ?? "shop_item",
        sku,
        priceStars: 50,
        chargedStars: 50,
        mode: patch.mode ?? "live",
        status: refunded ? "refunded" : "paid",
        invoicedAt: NOW,
        paidAt: patch.paidAt ?? new Date(NOW.getTime() - DAY),
        refundRequestedAt: patch.refundRequestedAt ?? null,
        refundedAt: patch.refundedAt ?? null,
      },
    });
  }

  beforeAll(() => {
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    redis = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    await redis.del(cacheKey);
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  it("один игрок купил набор 30 раз — один покупатель; другие игроки добавляются по одному", async () => {
    const sku = `t_${randomUUID().slice(0, 8)}`;
    const generous = await player();
    for (let i = 0; i < 30; i += 1) await buy(generous, sku);
    await redis.del(cacheKey);
    expect((await new ShopChoice(prisma, redis, cacheKey).counts(NOW)).get(sku)).toBe(1);

    await buy(await player(), sku);
    await redis.del(cacheKey);
    expect((await new ShopChoice(prisma, redis, cacheKey).counts(NOW)).get(sku)).toBe(2);
  });

  it("покупка 31 день назад, возврат, заказанный возврат и тестовая оплата не считаются; покупка 29 дней назад считается", async () => {
    const sku = `t_${randomUUID().slice(0, 8)}`;
    await buy(await player(), sku, { paidAt: new Date(NOW.getTime() - 31 * DAY) });
    await buy(await player(), sku, { refundedAt: new Date(NOW.getTime() - DAY) });
    await buy(await player(), sku, { refundRequestedAt: new Date(NOW.getTime() - DAY) });
    await buy(await player(), sku, { mode: "test" });
    await buy(await player(), sku, { paidAt: new Date(NOW.getTime() - 29 * DAY) });
    await redis.del(cacheKey);
    // В окне осталась одна живая оплата без возврата.
    expect((await new ShopChoice(prisma, redis, cacheKey).counts(NOW)).get(sku)).toBe(1);
  });

  it("второй запрос — из кеша, без запроса в базу; недоступный Redis — пустой счёт, а не ошибка", async () => {
    const sku = `t_${randomUUID().slice(0, 8)}`;
    await buy(await player(), sku);
    await redis.del(cacheKey);
    const choice = new ShopChoice(prisma, redis, cacheKey);
    const spy = vi.spyOn(prisma, "$transaction");
    expect((await choice.counts(NOW)).get(sku)).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await choice.counts(NOW)).get(sku)).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await redis.ttl(cacheKey)).toBeGreaterThan(0);
    spy.mockRestore();

    const broken = new ShopChoice(prisma, { get: async () => Promise.reject(new Error("connection refused")), set: async () => Promise.reject(new Error("connection refused")) }, cacheKey);
    expect((await broken.counts(NOW)).size).toBe(0);
  });
});
