import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { dayWindow } from "../src/modules/admin-notify/daily-stats.js";
import { PrismaDailyStatsRepository } from "../src/modules/admin-notify/daily-stats.repository.js";

/**
 * Цифры ежедневной статистики на живом Postgres. Данные — в далёких сутках,
 * куда не попадают записи соседних тестов: база общая, а счёт — по времени.
 * Граница суток — московская полночь: запись в 23:59 по Москве — в сутках,
 * в 00:00 — уже в следующих. Без базы — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const DAY = "2031-03-14";
const window = dayWindow(DAY);
const at = (hhmm: string) => new Date(Date.parse(`${DAY}T${hhmm}:00+03:00`));

describe.skipIf(DATABASE_URL === "")("ежедневная статистика на живом Postgres", () => {
  let prisma: PrismaClient;
  const accounts: string[] = [];

  async function account(createdAt: Date, source: "organic" | "click" | null): Promise<string> {
    const accountId = randomUUID();
    accounts.push(accountId);
    await prisma.account.create({ data: { accountId, platform: "telegram", platformUserId: `stats-${accountId.slice(0, 8)}`, displayName: "Тест", createdAt, lastSeenAt: createdAt } });
    if (source !== null) {
      await prisma.acquisition.create({ data: { accountId, firstAt: createdAt, firstStartKind: source, firstDeviceClass: "mobile", lastSeenAt: createdAt } });
    }
    return accountId;
  }

  async function session(accountId: string, startedAt: Date): Promise<void> {
    await prisma.accountSession.create({ data: { sessionId: randomUUID(), accountId, platform: "telegram", place: "miniapp", startKind: "organic", deviceClass: "mobile", os: "android", startedAt } });
  }

  async function run(accountId: string, finishedAt: Date, survivalSec: number, cheats = false): Promise<string> {
    const runId = randomUUID();
    await prisma.run.create({
      data: { runId, accountId, status: "finished", difficulty: "easy", startingWeaponId: "spark", contentHash: "h", startedAt: finishedAt, finishedAt, survivalSec, cheats, outcome: "died" },
    });
    return runId;
  }

  beforeAll(async () => {
    prisma = createPrisma(loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv));
    const anna = await account(at("00:05"), "organic");
    const boris = await account(at("23:59"), "click");
    await account(at("12:00"), null);
    // Полночь следующих суток — уже не эти сутки.
    const late = await account(new Date(window.to.getTime()), "organic");

    await session(anna, at("10:00"));
    await session(anna, at("11:00"));
    await session(boris, at("23:59"));
    await session(late, window.to);

    const annaRun = await run(anna, at("10:30"), 100);
    await run(anna, at("10:40"), 300);
    await run(boris, at("23:59"), 200);
    await run(boris, at("23:59"), 5000, true);

    await prisma.purchase.createMany({
      data: [
        { purchaseId: randomUUID(), accountId: anna, product: "continue_run", runId: annaRun, continueNo: 1, elapsedSec: 60, priceStars: 3, chargedStars: 3, mode: "live", status: "paid", invoicedAt: at("10:30"), paidAt: at("10:31") },
        { purchaseId: randomUUID(), accountId: anna, product: "continue_run", runId: annaRun, continueNo: 2, elapsedSec: 90, priceStars: 5, chargedStars: 5, mode: "live", status: "refunded", invoicedAt: at("10:32"), paidAt: at("10:33"), refundedAt: at("10:50") },
        // Тестовая оплата в выручку не идёт.
        { purchaseId: randomUUID(), accountId: anna, product: "continue_run", runId: annaRun, continueNo: 3, elapsedSec: 95, priceStars: 30, chargedStars: 1, mode: "test", status: "paid", invoicedAt: at("10:34"), paidAt: at("10:35") },
      ],
    });
    await prisma.accountFunnel.create({ data: { accountId: anna, enteredAt: at("00:05"), appOpenedAt: at("00:06"), firstRunStartedAt: at("10:00"), returnedD1At: at("10:00"), firstPurchaseAt: at("10:31") } });
    await prisma.accountFunnel.create({ data: { accountId: boris, enteredAt: at("23:59"), runs5At: new Date(window.to.getTime() + 60_000) } });
  });

  afterAll(async () => {
    await prisma.purchase.deleteMany({ where: { accountId: { in: accounts } } });
    await prisma.account.deleteMany({ where: { accountId: { in: accounts } } });
    await prisma.$disconnect();
  });

  it("считает сутки по московской полуночи, без читов и тестовых звёзд", async () => {
    const stats = await new PrismaDailyStatsRepository(prisma).day(window);
    expect(stats.accounts).toEqual({ organic: 1, click: 1, unknown: 1 });
    expect(stats.active).toBe(2);
    expect(stats.sessions).toBe(3);
    expect(stats.runs).toEqual({ finished: 3, players: 2, medianSurvivalSec: 200 });
    expect(stats.revenue).toEqual({ stars: 8, purchases: 2, refunds: 1 });
    expect(stats.funnel).toEqual({ entered: 2, appOpened: 1, firstRun: 1, runs5: 0, returnedD1: 1, returnedD7: 0, firstPurchase: 1 });
  });

  it("ряд по суткам: те же границы и фильтры, пустые сутки — нулями", async () => {
    const points = await new PrismaDailyStatsRepository(prisma).series(dayWindow("2031-03-13").from, dayWindow("2031-03-15").to);
    expect(points).toEqual([
      { day: "2031-03-13", newAccounts: 0, active: 0, finishedRuns: 0, stars: 0 },
      // Как у суток целиком: без читов, тестовая оплата не в счёт, возвращённая оплата — в сутках оплаты.
      { day: "2031-03-14", newAccounts: 3, active: 2, finishedRuns: 3, stars: 8 },
      { day: "2031-03-15", newAccounts: 1, active: 1, finishedRuns: 0, stars: 0 },
    ]);
  });

  it("пустые сутки — нули, а не ошибка", async () => {
    const stats = await new PrismaDailyStatsRepository(prisma).day(dayWindow("2031-03-20"));
    expect(stats).toMatchObject({ accounts: {}, active: 0, runs: { finished: 0, medianSurvivalSec: null }, revenue: { stars: 0 } });
  });
});
