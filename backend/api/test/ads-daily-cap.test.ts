import { describe, expect, it } from "vitest";
import { AdDailyCapError, AdNotCompletedError } from "../src/modules/ads/ads-errors.js";
import { AD_PLACES, CAPPED_PLACES, PLACE_RULES, dailyCapReached, type AdPlace } from "../src/modules/ads/ads-rules.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import type { AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { AdsService, type AdOffer, type AdViewer } from "../src/modules/ads/ads.service.js";
import { ProgressService } from "../src/modules/progress/progress.service.js";
import { RunDoubleService } from "../src/modules/progress/run-double.service.js";
import type { DoubleCandidate, RunDoubleRepository } from "../src/modules/progress/run-double.repository.js";
import type { WalletService } from "../src/modules/wallet/wallet.service.js";
import type { WheelRepository } from "../src/modules/wheel/wheel.repository.js";
import { WheelService } from "../src/modules/wheel/wheel.service.js";
import { FakeCreatives, MemoryAds, adBlock as block, interstitialGate } from "./helpers/memory-ads.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Дневной кап роликов за награду (docs/35-stage4-plan.md, Р155; T-0241):
 * общий счёт на игровые сутки по всем местам с наградой, кроме задания сети.
 * Пропуск VIP, задание и межстраничная в кап не входят; ключ панели
 * `ads.rewarded.daily-cap` — 12 по умолчанию, 0 выключает. На живой базе, с
 * настоящей блокировкой и московскими сутками, — `ads-daily-cap.integration.test.ts`.
 */

const ME = "00000000-0000-4000-8000-00000000cc01";
const MINUTE = 60_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
/** 01.10.2026, 00:00 по Москве — начало следующих игровых суток */
const NEXT_DAY = new Date(Date.UTC(2026, 8, 30, 21));
const VIEWER: AdViewer = { accountId: ME, platform: "telegram", device: "android" };
const KEY = "ads.rewarded.daily-cap";

const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);

/** Блоки всех мест с наградой: чтобы сети хватало на любое место, где тест просит показ. */
function blocksOfAllPlaces(): AdBlockRow[] {
  return CAPPED_PLACES.map((place, index) => block("adsgram", 10 + index, { place, success: "view" }));
}

function setup(blocks: AdBlockRow[] = blocksOfAllPlaces(), settings = panelSettings()) {
  const repository = new MemoryAds();
  repository.blocks = blocks;
  const passes = new AdPasses();
  const service = new AdsService(repository, () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(repository), interstitialGate(repository, settings), restrictionsGate());
  return { repository, passes, settings, service };
}

let sessionNo = 0;

/** Досмотренная сессия места — как её оставили бы клиент и SDK; `claimed` — хозяин места её забрал. */
async function watched(repository: MemoryAds, place: AdPlace, time: Date, options: { claimed?: boolean; success?: "view" } = {}): Promise<string> {
  sessionNo++;
  const sessionId = `cap-session-${String(sessionNo).padStart(6, "0")}`;
  const placeBlock = block("adsgram", 10, { place, success: options.success ?? "view" });
  await repository.createSession({ sessionId, accountId: ME, place, block: placeBlock, creative: null, createdAt: time, expiresAt: at(time, 30) });
  await repository.report(sessionId, ME, { kind: "completed" }, at(time, 1));
  if (options.claimed === true) await repository.claim(sessionId, ME, place, at(time, 1), () => ({ kind: "allow" }));
  return sessionId;
}

/** `count` досмотренных роликов, разложенных по местам с наградой по кругу. */
async function watchedRound(repository: MemoryAds, count: number, time: Date): Promise<void> {
  for (let index = 0; index < count; index++) await watched(repository, CAPPED_PLACES[index % CAPPED_PLACES.length] ?? "wheel_spin", at(time, -index - 2));
}

function offered(offer: AdOffer): Extract<AdOffer, { available: true }> {
  if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
  return offer;
}

describe("кап роликов — числа и правило", () => {
  it("кап достигнут на N-м ролике; без капа (0) — никогда", () => {
    expect(dailyCapReached(11, 12)).toBe(false);
    expect(dailyCapReached(12, 12)).toBe(true);
    expect(dailyCapReached(13, 12)).toBe(true);
    expect(dailyCapReached(0, 1)).toBe(false);
    expect(dailyCapReached(100, 0)).toBe(false);
  });

  it("под капом — места с наградой, кроме задания сети; межстраничная и задание не входят", () => {
    expect(CAPPED_PLACES).not.toContain("task");
    expect(CAPPED_PLACES).not.toContain("interstitial");
    expect([...CAPPED_PLACES].sort()).toEqual(["card_reroll", "run_double", "second_chance", "wheel_spin"]);
  });

  it("место под капом — любое будущее с наградой, кроме задания: список выводится из правил, а не пишется отдельно", () => {
    for (const place of AD_PLACES) {
      expect(CAPPED_PLACES.includes(place), place).toBe(PLACE_RULES[place].rewarded && place !== "task");
    }
  });
});

describe("кап роликов — готовность места и выдача", () => {
  it("11 роликов в разных местах — место готово; 12-й закрывает все места разом: available false, capped true", async () => {
    const { service, repository } = setup();
    await watchedRound(repository, 11, NOON);
    for (const place of CAPPED_PLACES) expect(await service.readiness(VIEWER, place, NOON), place).toMatchObject({ available: true, capped: false });

    await watched(repository, "wheel_spin", at(NOON, -1));
    for (const place of CAPPED_PLACES) expect(await service.readiness(VIEWER, place, NOON), place).toMatchObject({ available: false, capped: true, pass: null });
  });

  it("выдача при капе — 409 ad_daily_cap, сессия не заводится; до капа выдаёт как раньше", async () => {
    const { service, repository } = setup();
    await watchedRound(repository, 11, NOON);
    expect(await service.offer(VIEWER, "wheel_spin", NOON)).toMatchObject({ available: true });
    await watched(repository, "run_double", at(NOON, -1));
    const before = repository.sessions.length;
    const error = await service.offer(VIEWER, "second_chance", NOON).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdDailyCapError);
    expect(error).toMatchObject({ code: "ad_daily_cap", status: 409 });
    expect(repository.sessions).toHaveLength(before);
  });

  it("кап — раньше кулдауна: после забранной крутки колеса игроку говорят про кап, а не «загляни позже»", async () => {
    const { service, repository } = setup(blocksOfAllPlaces(), panelSettings({ [KEY]: 2 }));
    await watched(repository, "wheel_spin", at(NOON, -10), { claimed: true });
    await watched(repository, "run_double", at(NOON, -5));
    await expect(service.offer(VIEWER, "wheel_spin", NOON)).rejects.toBeInstanceOf(AdDailyCapError);
  });

  it("в счёт — только досмотренные: выданные, показанные и отказавшие сессии кап не двигают", async () => {
    const { service, repository } = setup(blocksOfAllPlaces(), panelSettings({ [KEY]: 2 }));
    for (const outcome of [{ kind: "shown" }, { kind: "failed", reason: "sdk_error" }] as const) {
      const sessionId = `cap-open-${outcome.kind}`;
      await repository.createSession({ sessionId, accountId: ME, place: "wheel_spin", block: block("adsgram", 10, { place: "wheel_spin" }), creative: null, createdAt: at(NOON, -20), expiresAt: at(NOON, 10) });
      await repository.report(sessionId, ME, outcome, at(NOON, -19));
    }
    await repository.createSession({ sessionId: "cap-pending", accountId: ME, place: "run_double", block: block("adsgram", 10, { place: "run_double" }), creative: null, createdAt: at(NOON, -20), expiresAt: at(NOON, 10) });
    await watched(repository, "second_chance", at(NOON, -15));
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toMatchObject({ capped: false });
    await watched(repository, "card_reroll", at(NOON, -14));
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toMatchObject({ capped: true });
  });

  it("задание сети и межстраничная в кап не входят, а места «за ролик» их кап не закрывает", async () => {
    const { service, repository } = setup([...blocksOfAllPlaces(), block("adsgram", 10, { place: "task", success: "view" }), block("adsgram", 10, { place: "interstitial", success: "view" })], panelSettings({ [KEY]: 3 }));
    for (let index = 0; index < 5; index++) await watched(repository, "task", at(NOON, -30 - index));
    for (let index = 0; index < 5; index++) await watched(repository, "interstitial", at(NOON, -50 - index));
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toMatchObject({ available: true, capped: false });
    await watchedRound(repository, 3, NOON);
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toMatchObject({ available: false, capped: true });
    // Межстраничную кап не касается: у неё своя политика, и отказ — её, а не «ad_daily_cap».
    expect(await service.readiness(VIEWER, "interstitial", NOON)).toMatchObject({ capped: false });
    await expect(service.offer(VIEWER, "interstitial", NOON)).resolves.toBeDefined();
  });

  it("сессии пропуска VIP не ролики: сколько бы их ни было, кап пуст", async () => {
    const { service, repository } = setup(blocksOfAllPlaces(), panelSettings({ [KEY]: 3 }));
    for (let index = 0; index < 6; index++) {
      await repository.createPassSession({ sessionId: `cap-pass-${String(index)}`, accountId: ME, place: CAPPED_PLACES[index % CAPPED_PLACES.length] ?? "wheel_spin", pass: "vip", createdAt: at(NOON, -index - 5), expiresAt: at(NOON, 30) });
    }
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toMatchObject({ available: true, capped: false });
  });

  it("VIP с пропуском при исчерпанном капе: награда без ролика проходит, кап не упирается", async () => {
    const { service, repository, passes } = setup();
    await watchedRound(repository, 12, NOON);
    passes.register("vip", async (accountId) => accountId === ME);
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toEqual({ available: true, readyAt: null, pass: "vip", capped: false });
    const offer = offered(await service.offer(VIEWER, "run_double", NOON));
    expect(offer.pass).toBe("vip");
    await expect(service.claim(ME, offer.sessionId, "run_double", NOON)).resolves.toMatchObject({ repeat: false });
  });

  it("игровые сутки — московские: до полуночи кап стоит, с полуночи пуст; вчерашние ролики не считаются", async () => {
    const { service, repository } = setup();
    await watchedRound(repository, 12, at(NEXT_DAY, -10));
    expect(await service.readiness(VIEWER, "wheel_spin", at(NEXT_DAY, -1))).toMatchObject({ capped: true });
    expect(await service.readiness(VIEWER, "wheel_spin", NEXT_DAY)).toMatchObject({ available: true, capped: false });
    expect(await service.offer(VIEWER, "run_double", at(NEXT_DAY, 1))).toMatchObject({ available: true });
  });

  it("число из панели: 3 — кап на третьем ролике; поднять — места снова открыты; 0 — кап выключен", async () => {
    const settings = panelSettings({ [KEY]: 3 });
    const { service, repository } = setup(blocksOfAllPlaces(), settings);
    await watchedRound(repository, 2, NOON);
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toMatchObject({ capped: false });
    await watched(repository, "card_reroll", at(NOON, -1));
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toMatchObject({ available: false, capped: true });

    settings.set(KEY, 4);
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toMatchObject({ available: true, capped: false });
    settings.set(KEY, 3);
    settings.set(KEY, 0);
    await watchedRound(repository, 40, NOON);
    expect(await service.readiness(VIEWER, "wheel_spin", NOON)).toMatchObject({ available: true, capped: false });
    expect(await service.offer(VIEWER, "second_chance", NOON)).toMatchObject({ available: true });
  });

  it("по умолчанию кап — 12", async () => {
    const { service, repository } = setup();
    await watchedRound(repository, 11, NOON);
    expect(await service.readiness(VIEWER, "run_double", NOON)).toMatchObject({ capped: false });
    await watched(repository, "second_chance", at(NOON, -1));
    expect(await service.readiness(VIEWER, "run_double", NOON)).toMatchObject({ capped: true });
  });

  it("чужие ролики игроку не мешают", async () => {
    const { service, repository } = setup();
    await watchedRound(repository, 12, NOON);
    const stranger: AdViewer = { ...VIEWER, accountId: "00000000-0000-4000-8000-00000000cc02" };
    expect(await service.readiness(stranger, "wheel_spin", NOON)).toMatchObject({ available: true, capped: false });
  });
});

describe("кап роликов — забор награды у хозяина места", () => {
  /** Три сессии в разных местах выданы, пока кап пуст, и досмотрены — как у двух экранов сразу. */
  async function threeWatched() {
    const ctx = setup(blocksOfAllPlaces(), panelSettings({ [KEY]: 2 }));
    const sessions: { place: AdPlace; sessionId: string }[] = [];
    // Выданы все три, пока кап свободен, и только потом досмотрены.
    for (const place of ["second_chance", "run_double", "card_reroll"] as const) {
      sessions.push({ place, sessionId: offered(await ctx.service.offer(VIEWER, place, NOON)).sessionId });
    }
    for (const { sessionId } of sessions) await ctx.service.report(ME, sessionId, { kind: "completed" }, at(NOON, 1));
    return { ...ctx, sessions };
  }

  it("сверх капа награду не отдать: третий забор — 409 ad_daily_cap, сессия остаётся незабранной", async () => {
    const { service, repository, sessions } = await threeWatched();
    const [first, second, third] = sessions;
    if (first === undefined || second === undefined || third === undefined) throw new Error("нет сессий");
    await service.claim(ME, first.sessionId, first.place, at(NOON, 2));
    await service.claim(ME, second.sessionId, second.place, at(NOON, 2));
    await expect(service.claim(ME, third.sessionId, third.place, at(NOON, 2))).rejects.toMatchObject({ code: "ad_daily_cap", status: 409 });
    expect(repository.sessions.find((row) => row.sessionId === third.sessionId)?.claimedAt).toBeNull();
  });

  it("гонка забора в разных местах: из трёх разом проходят ровно две", async () => {
    const { service, sessions } = await threeWatched();
    const results = await Promise.allSettled(sessions.map(({ place, sessionId }) => service.claim(ME, sessionId, place, at(NOON, 2))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(AdDailyCapError);
  });

  it("повтор уже забранной сессии при капе отдаёт её снова: хозяин дожимает свою награду", async () => {
    const { service, sessions } = await threeWatched();
    const [first, second] = sessions;
    if (first === undefined || second === undefined) throw new Error("нет сессий");
    await service.claim(ME, first.sessionId, first.place, at(NOON, 2));
    await service.claim(ME, second.sessionId, second.place, at(NOON, 2));
    await expect(service.claim(ME, first.sessionId, first.place, at(NOON, 3))).resolves.toMatchObject({ repeat: true });
  });

  it("недосмотренная сессия при капе — «не досмотрено», а не «кап»", async () => {
    const { service, repository } = setup(blocksOfAllPlaces(), panelSettings({ [KEY]: 1 }));
    const open = offered(await service.offer(VIEWER, "second_chance", NOON));
    await watched(repository, "wheel_spin", at(NOON, -10), { claimed: true });
    await expect(service.claim(ME, open.sessionId, "second_chance", NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
  });

  it("кап выключен (0) — забор не считает ролики", async () => {
    const { service, repository, sessions, settings } = await threeWatched();
    settings.set(KEY, 0);
    for (const { place, sessionId } of sessions) await service.claim(ME, sessionId, place, at(NOON, 2));
    expect(repository.sessions.filter((row) => row.claimedAt !== null)).toHaveLength(3);
  });

  it("задание сети забирается при любом числе роликов, пропуск VIP — тоже", async () => {
    const { service, repository, passes } = setup([...blocksOfAllPlaces(), block("adsgram", 10, { place: "task", success: "view" })], panelSettings({ [KEY]: 1 }));
    await watched(repository, "wheel_spin", at(NOON, -10));
    const task = await watched(repository, "task", at(NOON, -5));
    await expect(service.claim(ME, task, "task", NOON)).resolves.toMatchObject({ repeat: false });
    passes.register("vip", async () => true);
    const pass = offered(await service.offer(VIEWER, "run_double", NOON));
    await expect(service.claim(ME, pass.sessionId, "run_double", NOON)).resolves.toMatchObject({ repeat: false });
  });
});

describe("кап роликов — ответы хозяев мест", () => {
  class MemoryRunDouble implements RunDoubleRepository {
    async candidate(runId: string): Promise<DoubleCandidate | null> {
      return { runId, coinsCredited: 90, skipped: null, createdAt: NOON, doubleSessionId: null, doubledAt: null };
    }
    async attach(): Promise<boolean> {
      return true;
    }
    async markDoubled(): Promise<void> {}
  }

  it("удвоение за забег несёт ad.capped: true при капе, false до него", async () => {
    const { repository, service: ads } = setup();
    const service = new RunDoubleService(new MemoryRunDouble(), ads, {} as unknown as WalletService);
    const player = { accountId: ME, platform: "telegram" } as const;
    await watchedRound(repository, 11, NOON);
    expect(await service.view(player, "run-1", NOON)).toMatchObject({ status: "available", ad: { available: true, capped: false } });
    await watched(repository, "wheel_spin", at(NOON, -1));
    expect(await service.view(player, "run-1", NOON)).toMatchObject({ status: "available", ad: { available: false, capped: true, pass: null } });
  });

  it("колесо несёт ad.capped так же", async () => {
    const { repository, service: ads } = setup();
    const wheelRepository = { freeToday: async () => null } as unknown as WheelRepository;
    const progress = { view: async () => ({ level: 1 }) } as unknown as ProgressService;
    const service = new WheelService(wheelRepository, progress, {} as unknown as WalletService, ads, () => 0);
    const player = { accountId: ME, platform: "telegram" } as const;
    expect((await service.view(player, NOON)).ad).toEqual({ available: true, readyAt: null, pass: null, capped: false });
    await watchedRound(repository, 12, NOON);
    expect((await service.view(player, NOON)).ad).toEqual({ available: false, readyAt: null, pass: null, capped: true });
  });
});
