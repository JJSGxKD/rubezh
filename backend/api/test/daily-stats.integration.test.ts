import { randomBytes, randomUUID } from "node:crypto";
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
  /** своя сеть и блок: сессия без блока — это пропуск VIP, а не досмотр (Р99) */
  const network = `it_${randomBytes(4).toString("hex")}`;
  const blockId = randomUUID();

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
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка', true, 5, now())`;
    await prisma.$executeRaw`
      INSERT INTO ad_block (block_id, network_key, place, external_id, success, platforms, devices, created_at, updated_at)
      VALUES (${blockId}::uuid, ${network}, 'second_chance', 'ext-stats', 'view'::"AdSuccess", ARRAY['telegram']::"Platform"[], ARRAY['android']::varchar(16)[], now(), now())`;
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
    // Досмотренные показы: один в сутках, один — ровно за границей ряда (полночь после последних суток).
    const adSession = (accountId: string, completedAt: Date) =>
      prisma.adSession.create({
        data: { sessionId: randomUUID().replaceAll("-", ""), accountId, place: "second_chance", blockId, networkKey: network, success: "view", status: "completed", createdAt: new Date(completedAt.getTime() - 60_000), expiresAt: new Date(completedAt.getTime() + 3_600_000), completedAt },
      });
    await adSession(anna, at("12:00"));
    await adSession(anna, new Date(dayWindow("2031-03-15").to.getTime()));
    // Пропуск VIP — сессия без блока: в досмотры не входит, считается отдельно.
    const passSession = (accountId: string, completedAt: Date) =>
      prisma.$executeRaw`
        INSERT INTO ad_session (session_id, account_id, place, block_id, network_key, success, status, created_at, completed_at, expires_at)
        VALUES (${randomUUID().replaceAll("-", "")}, ${accountId}::uuid, 'wheel_spin'::"AdPlace", NULL, 'vip', 'view', 'completed',
                ${completedAt}, ${completedAt}, ${new Date(completedAt.getTime() + 3_600_000)})`;
    await passSession(anna, at("13:00"));
    await passSession(boris, at("14:00"));
    await prisma.accountFunnel.create({ data: { accountId: anna, enteredAt: at("00:05"), appOpenedAt: at("00:06"), firstRunStartedAt: at("10:00"), returnedD1At: at("10:00"), firstPurchaseAt: at("10:31") } });
    await prisma.accountFunnel.create({ data: { accountId: boris, enteredAt: at("23:59"), runs5At: new Date(window.to.getTime() + 60_000) } });
  });

  afterAll(async () => {
    await prisma.purchase.deleteMany({ where: { accountId: { in: accounts } } });
    await prisma.adSession.deleteMany({ where: { accountId: { in: accounts } } });
    await prisma.$executeRaw`DELETE FROM ad_block WHERE block_id = ${blockId}::uuid`;
    await prisma.$executeRaw`DELETE FROM ad_network WHERE network_key = ${network}`;
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
      { day: "2031-03-13", newAccounts: 0, active: 0, finishedRuns: 0, stars: 0, purchases: 0, adsCompleted: 0, adsPassed: 0 },
      // Как у суток целиком: без читов, тестовая оплата не в счёт, возвращённая оплата — в сутках оплаты;
      // досмотр за границей ряда в точки не попадает; два пропуска VIP — не досмотры.
      { day: "2031-03-14", newAccounts: 3, active: 2, finishedRuns: 3, stars: 8, purchases: 2, adsCompleted: 1, adsPassed: 2 },
      { day: "2031-03-15", newAccounts: 1, active: 1, finishedRuns: 0, stars: 0, purchases: 0, adsCompleted: 0, adsPassed: 0 },
    ]);
  });

  it("пустые сутки — нули, а не ошибка", async () => {
    const stats = await new PrismaDailyStatsRepository(prisma).day(dayWindow("2031-03-20"));
    expect(stats).toMatchObject({ accounts: {}, active: 0, runs: { finished: 0, medianSurvivalSec: null }, revenue: { stars: 0 } });
  });
});
