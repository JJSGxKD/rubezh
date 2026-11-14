import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { AdDailyCapError } from "../src/modules/ads/ads-errors.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { CAPPED_PLACES, type AdPlace } from "../src/modules/ads/ads-rules.js";
import { PrismaAdsRepository, type AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { AdsService, type AdOffer, type AdViewer } from "../src/modules/ads/ads.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaProgressRepository } from "../src/modules/progress/progress.repository.js";
import { PrismaRunDoubleRepository } from "../src/modules/progress/run-double.repository.js";
import { RunDoubleService } from "../src/modules/progress/run-double.service.js";
import type { WalletService } from "../src/modules/wallet/wallet.service.js";
import { FakeCreatives, interstitialGate } from "./helpers/memory-ads.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Дневной кап роликов на живом Postgres (docs/17-testing-strategy.md §4.2;
 * адрес — TEST_DATABASE_URL, без него пропуск; T-0241): счёт досмотренных
 * роликов за московские сутки по всем местам с наградой одним запросом,
 * без пропуска VIP, задания сети и межстраничной; забор сверх капа — под
 * общей блокировкой игрока, а не по месту.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const MINUTE = 60_000;
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
/** полночь на четверг, 01.10.2026, по Москве */
const MIDNIGHT = new Date(Date.UTC(2026, 8, 30, 21));
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);
const KEY = "ads.rewarded.daily-cap";

describe.skipIf(DATABASE_URL === "")("дневной кап роликов на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let repository: PrismaAdsRepository;
  /** свои сеть и блоки теста: общие из миграции выключены, чужие тесты наши не трогают */
  const network = `cap_${randomBytes(4).toString("hex")}`;
  const blocks = new Map<AdPlace, AdBlockRow>();

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(960_000_000 + Math.floor(Math.random() * 30_000_000)), displayName: "Кап", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  function blockOf(place: AdPlace): AdBlockRow {
    const found = blocks.get(place);
    if (found === undefined) throw new Error(`нет блока ${place}`);
    return found;
  }

  function service(settings = panelSettings()) {
    const passes = new AdPasses();
    const ads = new AdsService(repository, () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(repository), interstitialGate(repository as never, settings), restrictionsGate());
    return { ads, passes, settings };
  }

  const viewer = (accountId: string): AdViewer => ({ accountId, platform: "telegram", device: "android" });

  /** Досмотренная сессия места; `claimed` — хозяин места её забрал. */
  async function watched(accountId: string, place: AdPlace, time = NOON, claimed = false): Promise<string> {
    const sessionId = randomBytes(12).toString("base64url");
    await repository.createSession({ sessionId, accountId, place, block: blockOf(place), creative: null, createdAt: time, expiresAt: at(time, 30) });
    await repository.report(sessionId, accountId, { kind: "completed" }, at(time, 1));
    if (claimed) await repository.claim(sessionId, accountId, place, at(time, 1), () => ({ kind: "allow" }));
    return sessionId;
  }

  /** `count` досмотренных роликов по местам с наградой по кругу. */
  async function round(accountId: string, count: number, time = NOON): Promise<void> {
    for (let index = 0; index < count; index++) await watched(accountId, CAPPED_PLACES[index % CAPPED_PLACES.length] ?? "wheel_spin", time);
  }

  function offered(offer: AdOffer): Extract<AdOffer, { available: true }> {
    if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
    return offer;
  }

  beforeAll(async () => {
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaAdsRepository(prisma);
    await prisma.$executeRaw`INSERT INTO ad_network (network_key, name, active, priority, updated_at) VALUES (${network}, 'Проверка капа', true, 5, now())`;
    for (const place of [...CAPPED_PLACES, "task", "interstitial"] as const) {
      const blockId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO ad_block (block_id, network_key, place, external_id, success, platforms, devices, created_at, updated_at)
        VALUES (${blockId}::uuid, ${network}, ${place}::"AdPlace", ${`ext-${place}`}, 'view'::"AdSuccess", ARRAY['telegram']::"Platform"[], ARRAY['android']::varchar(16)[], now(), now())`;
      blocks.set(place, { blockId, networkKey: network, place, externalId: `ext-${place}`, success: "view", priority: 5, networkKeys: {}, platforms: ["telegram"], devices: ["android"] });
    }
  });

  afterAll(async () => {
    // Чужим тестам свои блоки не оставляем: выдача читает все включённые.
    await prisma.$executeRaw`UPDATE ad_block SET active = false WHERE network_key = ${network}`;
    await prisma.$executeRaw`UPDATE ad_network SET active = false WHERE network_key = ${network}`;
    await prisma.$disconnect();
  });

  it("счёт — одним запросом по всем местам с наградой за московские сутки; граница суток та же, что у истории места", async () => {
    const me = await account();
    await round(me, 5, NOON);
    expect(await repository.rewardedWatchedToday(me, NOON)).toBe(5);
    // Вчерашние сутки: до полуночи по Москве — ещё прежние, с полуночи — пусто.
    expect(await repository.rewardedWatchedToday(me, at(MIDNIGHT, -1))).toBe(5);
    expect(await repository.rewardedWatchedToday(me, MIDNIGHT)).toBe(0);
    expect(await repository.rewardedWatchedToday(me, at(MIDNIGHT, 1))).toBe(0);
    // Ролик за минуту до полуночи принадлежит ушедшим суткам, за минуту после — новым.
    await watched(me, "run_double", at(MIDNIGHT, -3));
    await watched(me, "run_double", at(MIDNIGHT, 5));
    expect(await repository.rewardedWatchedToday(me, at(MIDNIGHT, 10))).toBe(1);
  });

  it("в счёт не идут выданные и показанные без досмотра, отказавшие, пропуск VIP, задание сети и межстраничная; чужие ролики — тоже", async () => {
    const me = await account();
    const stranger = await account();
    await watched(stranger, "wheel_spin");
    // выдана, показана, отказала — без досмотра
    for (const outcome of [undefined, { kind: "shown" }, { kind: "failed", reason: "sdk_error" }] as const) {
      const sessionId = randomBytes(12).toString("base64url");
      await repository.createSession({ sessionId, accountId: me, place: "run_double", block: blockOf("run_double"), creative: null, createdAt: NOON, expiresAt: at(NOON, 30) });
      if (outcome !== undefined) await repository.report(sessionId, me, outcome, at(NOON, 1));
    }
    await repository.createPassSession({ sessionId: randomBytes(12).toString("base64url"), accountId: me, place: "wheel_spin", pass: "vip", createdAt: NOON, expiresAt: at(NOON, 30) });
    await watched(me, "task");
    await watched(me, "interstitial");
    expect(await repository.rewardedWatchedToday(me, NOON)).toBe(0);
    await watched(me, "card_reroll");
    expect(await repository.rewardedWatchedToday(me, NOON)).toBe(1);
  });

  it("12 роликов в разных местах: колесо — available false, capped true; выдача — 409 ad_daily_cap", async () => {
    const me = await account();
    const { ads } = service();
    await round(me, 11);
    expect(await ads.readiness(viewer(me), "wheel_spin", NOON)).toMatchObject({ available: true, capped: false });
    await watched(me, "wheel_spin");
    expect(await ads.readiness(viewer(me), "wheel_spin", NOON)).toMatchObject({ available: false, capped: true, pass: null });
    const error = await ads.offer(viewer(me), "second_chance", NOON).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdDailyCapError);
    expect(error).toMatchObject({ code: "ad_daily_cap", status: 409 });
    const [count] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM ad_session WHERE account_id = ${me}::uuid AND status = 'pending'`;
    expect(count?.count).toBe(0);
  });

  it("сессии пропуска VIP и задание сети в счёт не идут; VIP с пропуском при 12 роликах получает награду места", async () => {
    const me = await account();
    const { ads, passes } = service();
    await round(me, 12);
    passes.register("vip", async (accountId) => accountId === me);
    expect(await ads.readiness(viewer(me), "run_double", NOON)).toEqual({ available: true, readyAt: null, pass: "vip", capped: false });
    const pass = offered(await ads.offer(viewer(me), "run_double", NOON));
    expect(pass.pass).toBe("vip");
    await expect(ads.claim(me, pass.sessionId, "run_double", NOON)).resolves.toMatchObject({ repeat: false });
    // Пропуск ролика не прибавил: без VIP счёт прежний.
    expect(await repository.rewardedWatchedToday(me, NOON)).toBe(12);
  });

  it("новые игровые сутки — кап снова пуст", async () => {
    const me = await account();
    const { ads } = service();
    await round(me, 12, at(MIDNIGHT, -30));
    expect(await ads.readiness(viewer(me), "wheel_spin", at(MIDNIGHT, -1))).toMatchObject({ capped: true });
    expect(await ads.readiness(viewer(me), "wheel_spin", MIDNIGHT)).toMatchObject({ available: true, capped: false });
    expect(await ads.offer(viewer(me), "wheel_spin", at(MIDNIGHT, 1))).toMatchObject({ available: true });
  });

  it("ключ панели: 3 — кап на третьем ролике, 0 — кап выключен", async () => {
    const me = await account();
    const settings = panelSettings({ [KEY]: 3 });
    const { ads } = service(settings);
    await round(me, 2);
    expect(await ads.readiness(viewer(me), "wheel_spin", NOON)).toMatchObject({ capped: false });
    await watched(me, "card_reroll");
    expect(await ads.readiness(viewer(me), "wheel_spin", NOON)).toMatchObject({ available: false, capped: true });
    settings.set(KEY, 0);
    expect(await ads.readiness(viewer(me), "wheel_spin", NOON)).toMatchObject({ available: true, capped: false });
  });

  it("забор сверх капа — 409 ad_daily_cap, сессия остаётся незабранной; повтор забранной отдаёт её снова", async () => {
    const me = await account();
    const { ads } = service(panelSettings({ [KEY]: 2 }));
    const first = await watched(me, "second_chance");
    const second = await watched(me, "run_double");
    const third = await watched(me, "card_reroll");
    await ads.claim(me, first, "second_chance", at(NOON, 2));
    await ads.claim(me, second, "run_double", at(NOON, 2));
    await expect(ads.claim(me, third, "card_reroll", at(NOON, 2))).rejects.toMatchObject({ code: "ad_daily_cap", status: 409 });
    const [row] = await prisma.$queryRaw<{ status: string }[]>`SELECT status::text FROM ad_session WHERE session_id = ${third}`;
    expect(row?.status).toBe("completed");
    await expect(ads.claim(me, first, "second_chance", at(NOON, 3))).resolves.toMatchObject({ repeat: true });
  });

  it("гонка забора в разных местах: из четырёх разом при капе 3 проходят ровно три — общей блокировкой игрока, а не по месту", async () => {
    const me = await account();
    const { ads } = service(panelSettings({ [KEY]: 3 }));
    const sessions = await Promise.all(CAPPED_PLACES.map(async (place) => ({ place, sessionId: await watched(me, place) })));
    expect(sessions).toHaveLength(4);
    const results = await Promise.allSettled(sessions.map(({ place, sessionId }) => ads.claim(me, sessionId, place, at(NOON, 2))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected.map((result) => result.reason)).toEqual([expect.any(AdDailyCapError)]);
    const [claimed] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM ad_session WHERE account_id = ${me}::uuid AND claimed_at IS NOT NULL`;
    expect(claimed?.count).toBe(3);
  });

  it("задание сети забирается и при исчерпанном капе", async () => {
    const me = await account();
    const { ads } = service(panelSettings({ [KEY]: 1 }));
    await watched(me, "wheel_spin", NOON, true);
    const task = await watched(me, "task");
    await expect(ads.claim(me, task, "task", at(NOON, 2))).resolves.toMatchObject({ repeat: false });
  });

  it("GET удвоения за забег несёт ad.capped", async () => {
    const me = await account();
    const { ads } = service();
    const progress = new PrismaProgressRepository(prisma);
    const runId = `cap-it-${randomBytes(6).toString("hex")}`;
    await progress.recordRun({ runId, accountId: me, coins: 90, xp: 100, skipped: null, at: NOON });
    await progress.markCredited(runId, 90);
    const double = new RunDoubleService(new PrismaRunDoubleRepository(prisma), ads, {} as unknown as WalletService);
    const player = { accountId: me, platform: "telegram" } as const;
    expect(await double.view(player, runId, at(NOON, 5))).toMatchObject({ status: "available", ad: { available: true, capped: false } });
    await round(me, 12);
    expect(await double.view(player, runId, at(NOON, 5))).toMatchObject({ status: "available", ad: { available: false, capped: true } });
  });
});
