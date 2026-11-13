import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaProjectMonthRepository } from "../src/modules/stakeholders/project-month.repository.js";

/**
 * Выборка покупок месяца проекта на живом Postgres (docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL,
 * без него пропуск; Р218, tasks/T-0453): границы месяца по UTC, тестовые оплаты не входят, площадка берётся у
 * аккаунта покупателя.
 *
 * В общей тестовой базе параллельно пишут другие файлы, поэтому месяцы тут — из далёкого прошлого, куда соседи не
 * попадают, а каждый случай идёт в транзакции с откатом: после теста не остаётся ничего.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const STAMP = randomBytes(4).toString("hex");

class Rollback extends Error {}

describe.skipIf(DATABASE_URL === "")("месяц проекта на живом Postgres", () => {
  let prisma: PrismaClient;
  let counter = 0;

  beforeAll(() => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Случай внутри транзакции; в конце всегда откат. Ошибка проверки пролетает наружу как есть. */
  async function inTransaction(body: (tx: Prisma.TransactionClient, repository: PrismaProjectMonthRepository) => Promise<void>): Promise<void> {
    try {
      await prisma.$transaction(
        async (tx) => {
          await body(tx, new PrismaProjectMonthRepository(tx));
          throw new Rollback();
        },
        { timeout: 60_000, maxWait: 30_000 },
      );
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  }

  async function buyer(tx: Prisma.TransactionClient, platform: "telegram" | "max" | "vk" | "web"): Promise<string> {
    const accountId = randomUUID();
    await tx.account.create({ data: { accountId, platform, platformUserId: `pm-${STAMP}-${String(counter++)}`, displayName: "Покупатель" } });
    return accountId;
  }

  async function purchase(
    tx: Prisma.TransactionClient,
    accountId: string,
    patch: { stars: number; mode?: "live" | "test"; paidAt: Date | null; refundedAt?: Date; product?: "shop_item" | "donation" },
  ): Promise<void> {
    const product = patch.product ?? "shop_item";
    await tx.purchase.create({
      data: {
        purchaseId: randomUUID(),
        accountId,
        product,
        sku: product === "donation" ? "donation" : `pm-${STAMP}-${String(counter++)}`,
        priceStars: patch.stars,
        chargedStars: patch.stars,
        mode: patch.mode ?? "live",
        status: patch.paidAt === null ? "pending" : patch.refundedAt === undefined ? "paid" : "refunded",
        invoicedAt: new Date(),
        paidAt: patch.paidAt,
        ...(patch.refundedAt === undefined ? {} : { refundedAt: patch.refundedAt }),
      },
    });
  }

  const utc = (iso: string) => new Date(iso);

  it("оплата 31 октября 23:59:59 UTC — в октябре, 1 ноября 00:00 — в ноябре", async () => {
    await inTransaction(async (tx, repository) => {
      const account = await buyer(tx, "telegram");
      await purchase(tx, account, { stars: 100, paidAt: utc("2001-10-31T23:59:59.000Z") });
      await purchase(tx, account, { stars: 200, paidAt: utc("2001-11-01T00:00:00.000Z") });

      const october = await repository.purchases(utc("2001-10-01T00:00:00Z"), utc("2001-11-01T00:00:00Z"));
      const november = await repository.purchases(utc("2001-11-01T00:00:00Z"), utc("2001-12-01T00:00:00Z"));

      expect(october.map((row) => row.chargedStars)).toEqual([100]);
      expect(november.map((row) => row.chargedStars)).toEqual([200]);
    });
  });

  it("тестовая и неоплаченная покупки не входят; возвращённая приходит с отметкой возврата", async () => {
    await inTransaction(async (tx, repository) => {
      const account = await buyer(tx, "telegram");
      await purchase(tx, account, { stars: 50, paidAt: utc("2001-10-10T10:00:00Z") });
      await purchase(tx, account, { stars: 1, mode: "test", paidAt: utc("2001-10-10T10:00:00Z") });
      await purchase(tx, account, { stars: 70, paidAt: null });
      await purchase(tx, account, { stars: 30, paidAt: utc("2001-10-12T10:00:00Z"), refundedAt: utc("2001-12-20T10:00:00Z") });

      const rows = await repository.purchases(utc("2001-10-01T00:00:00Z"), utc("2001-11-01T00:00:00Z"));

      expect(rows.map((row) => row.chargedStars).sort((a, b) => a - b)).toEqual([30, 50]);
      expect(rows.find((row) => row.chargedStars === 30)?.refundedAt).toEqual(utc("2001-12-20T10:00:00Z"));
      expect(rows.find((row) => row.chargedStars === 50)?.refundedAt).toBeNull();
    });
  });

  it("площадка — из аккаунта покупателя, донат приходит видом donation", async () => {
    await inTransaction(async (tx, repository) => {
      const vk = await buyer(tx, "vk");
      const max = await buyer(tx, "max");
      await purchase(tx, vk, { stars: 11, paidAt: utc("2001-10-05T00:00:00Z") });
      await purchase(tx, max, { stars: 22, paidAt: utc("2001-10-06T00:00:00Z"), product: "donation" });

      const rows = await repository.purchases(utc("2001-10-01T00:00:00Z"), utc("2001-11-01T00:00:00Z"));

      expect(rows.map((row) => ({ stars: row.chargedStars, platform: row.platform, product: row.product })).sort((a, b) => a.stars - b.stars)).toEqual([
        { stars: 11, platform: "vk", product: "shop_item" },
        { stars: 22, platform: "max", product: "donation" },
      ]);
    });
  });

  it("первый месяц оплат — месяц самой ранней живой оплаты; тестовая и неоплаченная его не двигают", async () => {
    await inTransaction(async (tx, repository) => {
      const account = await buyer(tx, "telegram");
      await purchase(tx, account, { stars: 1, mode: "test", paidAt: utc("1999-03-10T00:00:00Z") });
      await purchase(tx, account, { stars: 5, paidAt: null });
      await purchase(tx, account, { stars: 100, paidAt: utc("2001-10-31T23:59:59Z") });

      const first = await repository.firstPaidMonth();

      // соседние файлы пишут настоящие даты: раньше октября 2001 года у них оплат нет
      expect(first).toBe("2001-10");
    });
  });
});
