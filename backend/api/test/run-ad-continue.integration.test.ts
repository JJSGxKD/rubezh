import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaPurchasesRepository } from "../src/modules/payments/purchases.repository.js";
import { RunAdContinueService } from "../src/modules/runs/run-ad-continue.service.js";
import { PrismaRunAdContinuesRepository } from "../src/modules/runs/run-ad-continues.repository.js";
import { AdContinueDailyCapError } from "../src/modules/runs/run-continue-errors.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { PrismaRunGemContinuesRepository } from "../src/modules/runs/run-gem-continues.repository.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { FakeCreatives, MemoryAds, adBlock, interstitialGate } from "./helpers/memory-ads.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Второй шанс за рекламу на настоящем Postgres (docs/35-stage4-plan.md
 * WP11, Р162). Память этого не покажет: один номер продолжения и одна сессия
 * держатся уникальными ключами базы, начало игровых суток считает база, а
 * предварительная проверка оплаты видит продолжение, взятое за рекламу,
 * одним запросом вместе с покупкой. Суточный потолок — по виду продолжения
 * (реклама и VIP порознь) и атомарный: два параллельных забора не пробивают
 * его, как пробил бы подсчёт, отделённый от записи.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);
const RACE_TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "")("второй шанс за рекламу на живом Postgres", () => {
  let prisma: PrismaClient;
  let continues: PrismaRunAdContinuesRepository;
  let gems: PrismaRunGemContinuesRepository;
  let purchases: PrismaPurchasesRepository;
  let runs: PrismaRunsRepository;
  let accounts: PrismaAccountRepository;

  async function startedRun(): Promise<{ accountId: string; runId: string }> {
    const account = await accounts.upsert(
      { platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Стрелок", username: null, photoUrl: null },
      Date.now(),
    );
    const runId = randomUUID();
    await runs.start({ runId, accountId: account.accountId, difficulty: "normal", startingWeaponId: "knife", contentHash: "abc", startedAt: new Date() });
    return { accountId: account.accountId, runId };
  }

  const session = () => randomUUID().replace(/-/g, "").slice(0, 16);

  beforeAll(() => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    continues = new PrismaRunAdContinuesRepository(prisma);
    gems = new PrismaRunGemContinuesRepository(prisma);
    purchases = new PrismaPurchasesRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("номер продолжения и сессия — по одному разу; повтор той же сессии — «повтор», а не ошибка", async () => {
    const { accountId, runId } = await startedRun();
    const sessionId = session();
    const grant = { runId, continueNo: 1, accountId, sessionId, networkKey: "adsgram", grantedAt: new Date() };

    expect(await continues.grant(grant, 5)).toBe("granted");
    expect(await continues.grant(grant, 5)).toBe("repeat");
    expect(await continues.grant({ ...grant, sessionId: session() }, 5)).toBe("taken");
    const other = await startedRun();
    expect(await continues.grant({ ...grant, runId: other.runId, accountId: other.accountId }, 5)).toBe("taken");

    expect(await continues.bySession(sessionId)).toEqual({ runId, continueNo: 1 });
    expect(await continues.bySession(session())).toBeNull();
    expect(await continues.numbers(runId)).toEqual([1]);
  });

  it("суточный счёт — с полуночи по Москве", async () => {
    const { accountId, runId } = await startedRun();
    const second = await startedRun();
    // 30.09.2026: 23:30 и 00:30 следующих суток по Москве.
    const lateEvening = new Date(Date.UTC(2026, 8, 30, 20, 30));
    const afterMidnight = new Date(Date.UTC(2026, 8, 30, 21, 30));
    await continues.grant({ runId, continueNo: 1, accountId, sessionId: session(), networkKey: "adsgram", grantedAt: lateEvening }, 5);
    await prisma.run.update({ where: { runId: second.runId }, data: { accountId } });
    await continues.grant({ runId: second.runId, continueNo: 1, accountId, sessionId: session(), networkKey: "vip", grantedAt: afterMidnight }, 5);

    // Реклама вечером — в прошлых сутках, VIP после полуночи — в новых; счёт у каждого вида свой.
    expect(await continues.todayCount(accountId, lateEvening, "ad")).toBe(1);
    expect(await continues.todayCount(accountId, lateEvening, "vip")).toBe(0);
    expect(await continues.todayCount(accountId, afterMidnight, "ad")).toBe(0);
    expect(await continues.todayCount(accountId, afterMidnight, "vip")).toBe(1);
    expect(await continues.todayCount(accountId, new Date(afterMidnight.getTime() + 60_000), "vip")).toBe(1);
  });

  it("потолок суток держит сама запись: два параллельных забора при потолке один — проходит один", async () => {
    const { accountId, runId } = await startedRun();
    const second = await startedRun();
    await prisma.run.update({ where: { runId: second.runId }, data: { accountId } });

    const results = await Promise.all([
      continues.grant({ runId, continueNo: 1, accountId, sessionId: session(), networkKey: "adsgram", grantedAt: NOON }, 1),
      continues.grant({ runId: second.runId, continueNo: 1, accountId, sessionId: session(), networkKey: "adsgram", grantedAt: NOON }, 1),
    ]);

    expect([...results].sort()).toEqual(["capped", "granted"]);
    expect(await continues.todayCount(accountId, NOON, "ad")).toBe(1);
    // Повтор уже записанного — «повтор», а не «потолок»: потолок не отнимает выданное.
    const winner = results[0] === "granted" ? { runId, continueNo: 1 } : { runId: second.runId, continueNo: 1 };
    const row = await prisma.runAdContinue.findUniqueOrThrow({ where: { runId_continueNo: winner } });
    expect(await continues.grant({ ...winner, accountId, sessionId: row.sessionId, networkKey: "adsgram", grantedAt: NOON }, 1)).toBe("repeat");
  }, RACE_TIMEOUT_MS);

  it("номер, купленный за самоцветы, рекламой не выдаётся: база видит таблицу рядом", async () => {
    const { accountId, runId } = await startedRun();
    await prisma.$executeRaw`INSERT INTO run_gem_continue (run_id, continue_no, account_id, elapsed_sec, price_gems, granted_at) VALUES (${runId}, 1, ${accountId}::uuid, 125, 4, now())`;

    expect(await continues.grant({ runId, continueNo: 1, accountId, sessionId: session(), networkKey: "adsgram", grantedAt: new Date() }, 5)).toBe("taken");
    expect(await continues.numbers(runId)).toEqual([]);
    // Тот же номер самоцветами второй раз — повтор, а реклама на нём не появилась.
    expect(await gems.find(runId, 1)).toMatchObject({ priceGems: 4, elapsedSec: 125 });
  });

  it("счёт за продолжение, уже взятое за рекламу, проверка оплаты видит взятым", async () => {
    const { accountId, runId } = await startedRun();
    const opened = await purchases.openInvoice({
      purchaseId: randomUUID(),
      accountId,
      runId,
      continueNo: 1,
      elapsedSec: 125,
      priceStars: 3,
      chargedStars: 3,
      mode: "live",
      invoicedAt: new Date(),
    });
    if (opened.kind !== "opened") throw new Error("счёт не открылся");
    await expect(purchases.checkout(opened.purchase.purchaseId)).resolves.toMatchObject({ runFinished: false, continueTaken: false });
    await continues.grant({ runId, continueNo: 1, accountId, sessionId: session(), networkKey: "adsgram", grantedAt: new Date() }, 5);
    await expect(purchases.checkout(opened.purchase.purchaseId)).resolves.toMatchObject({ continueTaken: true });
  });

  /** Сервис на живой базе продолжений; реклама — в памяти: сессии показа это другой модуль. */
  function adService(settings = panelSettings()) {
    const adsRepository = new MemoryAds();
    adsRepository.blocks = [adBlock("adsgram", 10, { place: "second_chance" })];
    const passes = new AdPasses();
    const ads = new AdsService(adsRepository, () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(adsRepository), interstitialGate(adsRepository, settings), restrictionsGate());
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL } as NodeJS.ProcessEnv);
    const service = new RunAdContinueService(config, runs, continues, ads, new RunContinues(), settings);
    service.onModuleInit();
    return { service, ads, passes, settings };
  }

  async function claimed(parts: ReturnType<typeof adService>, accountId: string, minutes: number): Promise<{ runId: string; continueNo: number }> {
    const { runId } = await startedRunOf(accountId);
    const player = { accountId, platform: "telegram" as const };
    const offer = await parts.ads.offer({ ...player, device: "android" }, "second_chance", at(minutes));
    if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
    await parts.ads.report(accountId, offer.sessionId, { kind: "completed" }, at(minutes));
    return { runId, ...(await parts.service.claim(player, runId, offer.sessionId, at(minutes))) };
  }

  async function startedRunOf(accountId: string): Promise<{ runId: string }> {
    const runId = randomUUID();
    await runs.start({ runId, accountId, difficulty: "normal", startingWeaponId: "knife", contentHash: "abc", startedAt: new Date() });
    return { runId };
  }

  it("второе рекламное продолжение за сутки — daily_cap, в базе одна строка; в полночь по Москве — снова", async () => {
    const { accountId } = await startedRun();
    const parts = adService();
    await claimed(parts, accountId, 0);

    await expect(claimed(parts, accountId, 60)).rejects.toBeInstanceOf(AdContinueDailyCapError);
    expect(await continues.todayCount(accountId, at(60), "ad")).toBe(1);
    // 12:00 по Москве + 12 ч = полночь: новые сутки.
    expect(await claimed(parts, accountId, 12 * 60 + 10)).toMatchObject({ continueNo: 1 });
    expect(await continues.todayCount(accountId, at(12 * 60 + 10), "ad")).toBe(1);
  }, RACE_TIMEOUT_MS);

  it("VIP с пропуском — пять за сутки, шестое — daily_cap; рекламное VIP-продолжение рядом не считается", async () => {
    const { accountId } = await startedRun();
    const parts = adService();
    // Реклама до VIP: свой вид, свой счёт.
    await claimed(parts, accountId, 0);
    parts.passes.register("vip", async (id) => id === accountId);
    for (let index = 1; index <= 5; index++) await claimed(parts, accountId, index * 10);

    await expect(claimed(parts, accountId, 70)).rejects.toBeInstanceOf(AdContinueDailyCapError);
    expect(await continues.todayCount(accountId, at(70), "vip")).toBe(5);
    expect(await continues.todayCount(accountId, at(70), "ad")).toBe(1);
  }, RACE_TIMEOUT_MS);

  it("ключ continue.ad-per-day = 3 — три рекламных за сутки, четвёртое — daily_cap", async () => {
    const { accountId } = await startedRun();
    const parts = adService(panelSettings({ "continue.ad-per-day": 3 }));
    for (let index = 0; index < 3; index++) await claimed(parts, accountId, index * 10);

    await expect(claimed(parts, accountId, 40)).rejects.toBeInstanceOf(AdContinueDailyCapError);
    expect(await continues.todayCount(accountId, at(40), "ad")).toBe(3);
  }, RACE_TIMEOUT_MS);
});
