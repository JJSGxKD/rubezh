import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AdCooldownError, AdNotCompletedError, AdSessionClosedError } from "../src/modules/ads/ads-errors.js";
import {
  CLAIM_WINDOW_MIN,
  PLACE_RULES,
  SESSION_TTL_MIN,
  cooldownMinutes,
  networkOrder,
  nextRewardAt,
  placeState,
  type AdPlace,
  type PlaceHistoryEntry,
} from "../src/modules/ads/ads-rules.js";
import { REWARDED_VIDEO_PLACES } from "../src/modules/ads/interstitial-gate.js";
import { COUNTED_RUN_SEC, INTERSTITIAL_FLAG, interstitialRule, type InterstitialFacts, type InterstitialNumbers } from "../src/modules/ads/interstitial-policy.js";
import type { AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { AdsController } from "../src/modules/ads/ads.controller.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdAudience } from "../src/modules/ads/ad-audience.js";
import { eligibleBlocks } from "../src/modules/ads/ad-blocks.js";
import { NetworkCreatives, taddyUser, type AdRequester } from "../src/modules/ads/ad-creatives.js";
import { CREATIVE_VIEW_SEC } from "../src/modules/ads/ad-networks.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import type { TaddyApi, TaddyUser } from "../src/modules/ads/taddy-api.js";
import { AdsService, INTERSTITIAL_CREATIVE_TIMEOUT_MS, type AdOffer, type AdViewer, type AdsRoll } from "../src/modules/ads/ads.service.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { CREATIVE, FakeCreatives, MemoryAds, adBlock as block, flagsOn, interstitialGate, moscowDayStart } from "./helpers/memory-ads.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Реклама (docs/35-stage4-plan.md §3.7, WP12): выбор сети — пауза, круг,
 * отказ и давность; растущий кулдаун, переживающий полночь; воронка, где
 * клиент засчитывает только показ; одна награда на сессию и на кулдаун.
 */

const ME = "00000000-0000-4000-8000-00000000ad01";
const OTHER = "00000000-0000-4000-8000-00000000ad02";
const MINUTE = 60_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const TELEGRAM: AdViewer = { accountId: ME, platform: "telegram", device: "android" };
const REQUESTER: AdRequester = { platformUserId: "777000111", ip: "203.0.113.7", userAgent: "Telegram-Android/11", language: "ru", premium: false };
/** Игрок, которому сеть с API может дать креатив: Telegram ID, адрес и браузер. */
const PLAYER: AdViewer = { ...TELEGRAM, requester: REQUESTER };
const SECOND = 1_000;

const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);

/** Бросок по очереди из списка — какой блок сети выпадет, решает тест. */
function rolls(...values: number[]): AdsRoll {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

/** Десяток долгих забегов два дня назад: игрок бывалый, межстраничная ему положена. */
function veteran(repository: MemoryAds, accountId: string): void {
  for (let index = 0; index < 10; index++) repository.runs.push({ accountId, finishedAt: at(NOON, -2 * 24 * 60 + index * 10), survivalSec: 300 });
}

function setup(blocks: AdBlockRow[], roll: AdsRoll = rolls(0)) {
  const repository = new MemoryAds();
  repository.blocks = blocks;
  // Игроки бывалые и в доле выката: межстраничная им положена, пока тест не скажет иначе.
  for (const accountId of [ME, OTHER]) veteran(repository, accountId);
  const passes = new AdPasses();
  const settings = panelSettings();
  const creatives = new FakeCreatives();
  const flags = flagsOn(INTERSTITIAL_FLAG);
  const gate = interstitialGate(repository, settings, flags);
  return { repository, passes, settings, creatives, flags, service: new AdsService(repository, roll, passes, settings, creatives, new AdNetworkKeys(repository), gate) };
}

function offered(offer: AdOffer): Extract<AdOffer, { available: true }> {
  if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
  return offer;
}

/** Выдать, досмотреть и забрать — как это сделали бы клиент и хозяин места. */
async function watch(service: AdsService, place: AdPlace, time: Date, viewer = TELEGRAM): Promise<Extract<AdOffer, { available: true }>> {
  const offer = offered(await service.offer(viewer, place, time));
  await service.report(viewer.accountId, offer.sessionId, { kind: "completed" }, at(time, 1));
  await service.claim(viewer.accountId, offer.sessionId, place, at(time, 1));
  return offer;
}

function entry(networkKey: string, createdAt: Date, extra: Partial<PlaceHistoryEntry> = {}): PlaceHistoryEntry {
  return { networkKey, createdAt, shownAt: null, claimedAt: null, ...extra };
}

describe("числа рекламы", () => {
  it("кулдаун растёт с каждой наградой суток и упирается в потолок; до первой награды — ноль", () => {
    const wheel = PLACE_RULES.wheel_spin.cooldown;
    expect([0, 1, 2, 3, 4, 10].map((ordinal) => cooldownMinutes(wheel, ordinal))).toEqual([0, 120, 180, 270, 360, 360]);
    const double = PLACE_RULES.run_double.cooldown;
    expect([1, 2, 3].map((ordinal) => cooldownMinutes(double, ordinal))).toEqual([5, 8, 11]);
    expect(cooldownMinutes(double, 50)).toBe(60);
    expect(cooldownMinutes(null, 5)).toBe(0);
  });

  it("у каждого места кулдаун не короче базы и потолок не ниже базы, у показа — сроки на шаги воронки", () => {
    for (const rules of Object.values(PLACE_RULES)) {
      if (rules.cooldown === null) continue;
      expect(rules.cooldown.baseMin).toBeGreaterThan(0);
      expect(rules.cooldown.factor).toBeGreaterThanOrEqual(1);
      expect(rules.cooldown.capMin).toBeGreaterThanOrEqual(rules.cooldown.baseMin);
    }
    expect(SESSION_TTL_MIN.cpa).toBeGreaterThan(SESSION_TTL_MIN.view);
    expect(CLAIM_WINDOW_MIN.cpa).toBeGreaterThan(CLAIM_WINDOW_MIN.view);
  });

  it("состояние места: награды этих суток отдельно от вчерашних, пауза — только за последний час и с отказавшими сетями", () => {
    const dayStart = moscowDayStart(NOON);
    const state = placeState(
      [
        entry("adsgram", at(dayStart, -60), { claimedAt: at(dayStart, -59) }),
        entry("adsgram", at(NOON, -300), { shownAt: at(NOON, -299), claimedAt: at(NOON, -298) }),
        entry("richads", at(NOON, -200), { shownAt: at(NOON, -199), claimedAt: at(NOON, -198) }),
        entry("taddy", at(NOON, -30)),
        entry("adsonar", at(NOON, -61)),
      ],
      dayStart,
      NOON,
    );
    expect(state.lastReward).toEqual({ at: at(NOON, -198), ordinal: 2 });
    expect(state.lastRewardedToday).toBe("richads");
    expect([...state.seenAt.keys()]).toEqual(["taddy"]);
  });

  it("кулдаун переживает полночь, а круг сетей — нет", () => {
    const midnight = moscowDayStart(NOON);
    const lateNight = at(midnight, -10);
    const state = placeState(
      [1, 2, 3].map((index) => entry("adsgram", at(lateNight, -index * 300), { claimedAt: at(lateNight, index === 1 ? 0 : -index * 300) })),
      midnight,
      at(midnight, 10),
    );
    expect(state.lastReward?.ordinal).toBe(3);
    expect(state.lastRewardedToday).toBeNull();
    expect(nextRewardAt("wheel_spin", state, at(midnight, 10))).toEqual(at(lateNight, 270));
  });

  it("порядок сетей: без истории — по приоритету, круг — от сети последней награды, выданная за час — в конце очереди", () => {
    const networks = [
      { networkKey: "richads", priority: 30 },
      { networkKey: "adsgram", priority: 10 },
      { networkKey: "adsonar", priority: 20 },
      { networkKey: "taddy", priority: 30 },
    ];
    const keys = (order: { networkKey: string }[]) => order.map((network) => network.networkKey);
    expect(keys(networkOrder(networks, new Map(), null))).toEqual(["adsgram", "adsonar", "richads", "taddy"]);
    expect(keys(networkOrder(networks, new Map(), "adsonar"))).toEqual(["richads", "taddy", "adsgram", "adsonar"]);
    expect(keys(networkOrder(networks, new Map([["richads", 1]]), "adsonar"))).toEqual(["taddy", "adsgram", "adsonar"]);
    expect(keys(networkOrder(networks, new Map(), "gone"))).toEqual(["adsgram", "adsonar", "richads", "taddy"]);
    const allSeen = new Map([
      ["adsgram", 40],
      ["adsonar", 10],
      ["richads", 30],
      ["taddy", 20],
    ]);
    expect(keys(networkOrder(networks, allSeen, "adsgram"))).toEqual(["adsonar", "taddy", "richads", "adsgram"]);
  });

  it("блоки места — по площадке сети и устройству; пустой список площадок — везде, где работает сеть, неизвестное устройство — только туда, где не ограничено", () => {
    const everywhere = block("adsgram", 10);
    const telegramOnly = block("adsonar", 20, { platforms: ["telegram"] });
    // Заведён до площадок в профиле: VK сети чужая — блок не выдаётся нигде.
    const withVk = block("richads", 25, { platforms: ["telegram", "vk"] });
    const mobile = block("richads", 30, { devices: ["android", "ios"] });
    const otherPlace = block("taddy", 40, { place: "run_double" });
    const all = [everywhere, telegramOnly, withVk, mobile, otherPlace];
    expect(eligibleBlocks(all, "wheel_spin", { platform: "telegram", device: "android" })).toEqual([everywhere, telegramOnly, mobile]);
    // Блок «на всех площадках» сети Telegram в VK не показывается — её SDK там нет.
    expect(eligibleBlocks(all, "wheel_spin", { platform: "vk", device: "desktop" })).toEqual([]);
    expect(eligibleBlocks(all, "wheel_spin", { platform: "telegram", device: null })).toEqual([everywhere, telegramOnly]);
  });
});

describe("выдача показа", () => {
  it("нет блоков в месте — честное «недоступно», а не ошибка", async () => {
    const { service, repository } = setup([block("adsgram", 10, { place: "run_double" })]);
    expect(await service.offer(TELEGRAM, "wheel_spin", NOON)).toEqual({ available: false, reason: "no_fill", retryAt: null });
    expect(repository.sessions).toHaveLength(0);
  });

  it("первой — сеть с высшим приоритетом; сессия живёт по условию успеха, SDK получает блок, формат места и ключи сети", async () => {
    const adsgram = block("adsgram", 10);
    const { service, repository } = setup([block("adsonar", 20), adsgram]);
    const offer = offered(await service.offer(TELEGRAM, "wheel_spin", NOON));
    expect(offer).toMatchObject({ network: "adsgram", blockId: adsgram.externalId, format: "rewarded", keys: {}, success: "view", expiresAt: at(NOON, SESSION_TTL_MIN.view).toISOString() });
    // Сеть без блока в кабинете показывает по своим ключам — их SDK и получает.
    const richads = setup([block("richads", 10, { place: "interstitial" })]);
    expect(offered(await richads.service.offer(TELEGRAM, "interstitial", NOON))).toMatchObject({
      network: "richads",
      blockId: null,
      format: "interstitial",
      keys: { pubId: "1001262", appId: "6023" },
    });
    expect(offer.sessionId).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(repository.sessions[0]).toMatchObject({ sessionId: offer.sessionId, accountId: ME, place: "wheel_spin", status: "pending" });
  });

  it("тестовые показы — по настройке панели, сразу на следующей выдаче; по умолчанию — боевые", async () => {
    const { service, settings } = setup([block("adsgram", 10), block("adsonar", 20)]);
    expect(offered(await service.offer(TELEGRAM, "wheel_spin", NOON)).debug).toBe(false);
    settings.set("ads.test-mode", true);
    expect(offered(await service.offer(TELEGRAM, "wheel_spin", at(NOON, 1))).debug).toBe(true);
  });

  it("отказ первой сети уводит к следующей, все на паузе — к давнее всех выданной", async () => {
    const { service } = setup([block("adsgram", 10), block("adsonar", 20), block("richads", 30)]);
    const networks: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const offer = offered(await service.offer(TELEGRAM, "wheel_spin", at(NOON, attempt)));
      networks.push(offer.network);
      await service.report(ME, offer.sessionId, { kind: "failed", reason: "no_fill" }, at(NOON, attempt));
    }
    expect(networks).toEqual(["adsgram", "adsonar", "richads", "adsgram"]);
  });

  it("после награды круг идёт дальше от её сети, а не с начала", async () => {
    const { service } = setup([block("adsgram", 10, { place: "run_double" }), block("adsonar", 20, { place: "run_double" }), block("richads", 30, { place: "run_double" })]);
    const first = await watch(service, "run_double", NOON);
    expect(first.network).toBe("adsgram");
    // Через два часа пауза сети прошла, но круг помнит последнюю награду суток.
    const second = await watch(service, "run_double", at(NOON, 120));
    expect(second.network).toBe("adsonar");
    expect(offered(await service.offer(TELEGRAM, "run_double", at(NOON, 240))).network).toBe("richads");
  });

  it("внутри сети блок выбирается случайно", async () => {
    const first = block("adsgram", 10);
    const second = block("adsgram", 10);
    const { service } = setup([first, second], rolls(1, 0));
    expect(offered(await service.offer(TELEGRAM, "wheel_spin", NOON)).blockId).toBe(second.externalId);
    expect(offered(await service.offer({ ...TELEGRAM, accountId: OTHER }, "wheel_spin", NOON)).blockId).toBe(first.externalId);
  });

  it("блоки площадки и устройства: мобильный блок не предлагается десктопу", async () => {
    const { service } = setup([block("richads", 30, { devices: ["android", "ios"] })]);
    expect(await service.offer({ ...TELEGRAM, device: "desktop" }, "wheel_spin", NOON)).toMatchObject({ available: false, reason: "no_fill" });
    expect(await service.offer({ ...TELEGRAM, device: null }, "wheel_spin", NOON)).toMatchObject({ available: false, reason: "no_fill" });
    expect((await service.offer(TELEGRAM, "wheel_spin", NOON)).available).toBe(true);
  });

  it("после награды место отдыхает, и каждая следующая пауза длиннее", async () => {
    const { service } = setup([block("adsgram", 10)]);
    await watch(service, "wheel_spin", NOON);
    expect(await service.offer(TELEGRAM, "wheel_spin", at(NOON, 60))).toEqual({ available: false, reason: "cooldown", retryAt: at(NOON, 121).toISOString() });
    await watch(service, "wheel_spin", at(NOON, 121));
    expect(await service.offer(TELEGRAM, "wheel_spin", at(NOON, 200))).toMatchObject({ reason: "cooldown", retryAt: at(NOON, 122 + 180).toISOString() });
    // Кулдаун — у места, а не у игрока целиком.
    expect(await service.offer(TELEGRAM, "run_double", at(NOON, 200))).toMatchObject({ available: false, reason: "no_fill" });
  });

  it("блоки читаются из базы раз в полминуты, а правка из панели сбрасывает запас", async () => {
    const { service, repository } = setup([block("adsgram", 10)]);
    await service.offer(TELEGRAM, "wheel_spin", NOON);
    await service.offer({ ...TELEGRAM, accountId: OTHER }, "wheel_spin", NOON);
    expect(repository.blockReads).toBe(1);
    service.forgetBlocks();
    await service.offer({ ...TELEGRAM, accountId: OTHER }, "run_double", NOON);
    expect(repository.blockReads).toBe(2);
  });
});

describe("воронка показа", () => {
  it("досмотр засчитывается только там, где успех — показ; клик и целевое действие подтверждает сервер", async () => {
    const { service, repository } = setup([block("adsgram", 10, { place: "task" })]);
    const offer = offered(await service.offer(TELEGRAM, "task", NOON));
    expect(offer.success).toBe("cpa");
    await service.report(ME, offer.sessionId, { kind: "shown" }, NOON);
    await service.report(ME, offer.sessionId, { kind: "clicked" }, at(NOON, 1));
    await expect(service.report(ME, offer.sessionId, { kind: "completed" }, at(NOON, 1))).rejects.toBeInstanceOf(AdSessionClosedError);
    expect(repository.sessions[0]).toMatchObject({ status: "shown", shownAt: NOON, clickedAt: at(NOON, 1), completedAt: null });
    await expect(service.claim(ME, offer.sessionId, "task", at(NOON, 2))).rejects.toBeInstanceOf(AdNotCompletedError);
  });

  it("чужая, истёкшая и отказавшая сессия шагов не принимает", async () => {
    const { service } = setup([block("adsgram", 10)]);
    const offer = offered(await service.offer(TELEGRAM, "wheel_spin", NOON));
    await expect(service.report(OTHER, offer.sessionId, { kind: "completed" }, NOON)).rejects.toBeInstanceOf(AdSessionClosedError);
    await expect(service.report(ME, offer.sessionId, { kind: "completed" }, at(NOON, SESSION_TTL_MIN.view))).rejects.toBeInstanceOf(AdSessionClosedError);
    await service.report(ME, offer.sessionId, { kind: "failed", reason: "sdk_error" }, NOON);
    await expect(service.report(ME, offer.sessionId, { kind: "completed" }, NOON)).rejects.toBeInstanceOf(AdSessionClosedError);
    await expect(service.report(ME, "no-such-session", { kind: "shown" }, NOON)).rejects.toBeInstanceOf(AdSessionClosedError);
  });
});

describe("креатив сети с API (Taddy, Р78)", () => {
  it("креатив берёт сервер: выдача несёт объявление и срок досмотра, ключей SDK клиенту не нужно", async () => {
    const { service, repository, creatives } = setup([block("taddy", 10), block("taddy", 10, { place: "interstitial" })]);
    const offer = offered(await service.offer(PLAYER, "wheel_spin", NOON));
    expect(offer).toMatchObject({ network: "taddy", blockId: null, format: "rewarded", keys: {}, creative: { ad: CREATIVE, viewSec: CREATIVE_VIEW_SEC.rewarded } });
    expect(creatives.requests).toEqual([{ networkKey: "taddy", keys: { pubId: "14cbeb980853dd416003462ca4db7c12" }, requester: REQUESTER }]);
    expect(repository.sessions[0]).toMatchObject({ status: "pending", creativeId: CREATIVE.id, viewSec: CREATIVE_VIEW_SEC.rewarded });

    const interstitial = offered(await service.offer(PLAYER, "interstitial", NOON));
    expect(interstitial.creative?.viewSec).toBe(CREATIVE_VIEW_SEC.interstitial);
  });

  it("у сети нет креатива — выдача сразу идёт к следующей, а отказ записан сессией и ставит сеть на паузу", async () => {
    const { service, repository, creatives } = setup([block("taddy", 10), block("adsgram", 20)]);
    creatives.answer = () => ({ kind: "none", reason: "no_fill" });
    const offer = offered(await service.offer(PLAYER, "wheel_spin", NOON));
    expect(offer).toMatchObject({ network: "adsgram", creative: null });
    expect(repository.sessions.map((session) => [session.networkKey, session.status, session.failReason])).toEqual([
      ["taddy", "failed", "no_fill"],
      ["adsgram", "pending", null],
    ]);
    const history = await repository.history(ME, "wheel_spin", NOON);
    expect([...placeState(history.sessions, history.dayStart, NOON).seenAt.keys()].sort()).toEqual(["adsgram", "taddy"]);
  });

  it("единственная сеть без креатива — честное «нет рекламы»", async () => {
    const { service, repository, creatives } = setup([block("taddy", 10)]);
    creatives.answer = () => ({ kind: "none", reason: "timeout" });
    expect(await service.offer(PLAYER, "wheel_spin", NOON)).toEqual({ available: false, reason: "no_fill", retryAt: null });
    expect(repository.sessions).toMatchObject([{ status: "failed", failReason: "timeout" }]);
  });

  it("показ сеть узнаёт один раз; досмотр — не раньше срока от выдачи, и тогда же его узнаёт сеть", async () => {
    const { service, creatives } = setup([block("taddy", 10)]);
    const offer = offered(await service.offer(PLAYER, "wheel_spin", NOON));
    const time = (ms: number) => new Date(NOON.getTime() + ms);
    await service.report(ME, offer.sessionId, { kind: "shown" }, time(SECOND), REQUESTER);
    await service.report(ME, offer.sessionId, { kind: "shown" }, time(2 * SECOND), REQUESTER);
    expect(creatives.notes).toEqual([{ kind: "shown", networkKey: "taddy", creativeId: CREATIVE.id, requester: REQUESTER }]);

    // Клиент поторопился: отсчёт блока ещё идёт — досмотра нет, награды нет.
    await expect(service.report(ME, offer.sessionId, { kind: "completed" }, time(CREATIVE_VIEW_SEC.rewarded * SECOND - 1))).rejects.toBeInstanceOf(AdSessionClosedError);
    await service.report(ME, offer.sessionId, { kind: "completed" }, time(CREATIVE_VIEW_SEC.rewarded * SECOND), REQUESTER);
    expect(creatives.notes.map((note) => note.kind)).toEqual(["shown", "viewed"]);
    expect(await service.claim(ME, offer.sessionId, "wheel_spin", time(11 * SECOND))).toMatchObject({ repeat: false });
  });

  it("шаг показа потерялся по дороге — досмотр отмечает и показ; клик — шаг воронки без отметки сети", async () => {
    const { service, repository, creatives } = setup([block("taddy", 10)]);
    const offer = offered(await service.offer(PLAYER, "wheel_spin", NOON));
    await service.report(ME, offer.sessionId, { kind: "clicked" }, at(NOON, 0.1));
    expect(creatives.notes).toEqual([]);
    await service.report(ME, offer.sessionId, { kind: "completed" }, at(NOON, 1));
    expect(creatives.notes.map((note) => note.kind)).toEqual(["shown", "viewed"]);
    expect(repository.sessions[0]).toMatchObject({ clickedAt: at(NOON, 0.1), shownAt: at(NOON, 1), status: "completed" });
  });

  it("показ SDK сети сервер ей не отмечает — это делает сам SDK", async () => {
    const { service, creatives } = setup([block("adsgram", 10)]);
    const offer = offered(await service.offer(PLAYER, "wheel_spin", NOON));
    await service.report(ME, offer.sessionId, { kind: "shown" }, NOON, REQUESTER);
    await service.report(ME, offer.sessionId, { kind: "completed" }, at(NOON, 1), REQUESTER);
    expect(creatives.requests).toEqual([]);
    expect(creatives.notes).toEqual([]);
  });
});

describe("Taddy: игрок и отметки", () => {
  class FakeTaddy implements TaddyApi {
    readonly calls: { method: string; pubId: string; user: TaddyUser; extra: string | null }[] = [];
    failing = false;
    async getAd(pubId: string, user: TaddyUser) {
      this.calls.push({ method: "getAd", pubId, user, extra: null });
      return { kind: "ad" as const, ad: { ...CREATIVE } };
    }
    async impression(pubId: string, user: TaddyUser, adId: string) {
      if (this.failing) throw new Error("сеть недоступна");
      this.calls.push({ method: "impression", pubId, user, extra: adId });
    }
    async viewThrough(pubId: string, user: TaddyUser, adId: string) {
      this.calls.push({ method: "viewThrough", pubId, user, extra: adId });
    }
    async start(pubId: string, user: TaddyUser, startParam: string | null) {
      this.calls.push({ method: "start", pubId, user, extra: startParam });
    }
  }

  function creativesWith(networks?: { networkKey: string; keys: Record<string, string> }[]) {
    const repository = new MemoryAds();
    if (networks !== undefined) repository.networks = networks;
    const taddy = new FakeTaddy();
    return { taddy, creatives: new NetworkCreatives(taddy, new AdNetworkKeys(repository)) };
  }

  it("игрок для Taddy — Telegram ID числом, основной подтег языка, без пустых полей; входу разработчика креатива нет", () => {
    expect(taddyUser({ ...REQUESTER, language: "pt-BR", premium: true })).toEqual({ id: 777000111, language: "pt", premium: true, ip: "203.0.113.7", userAgent: "Telegram-Android/11" });
    expect(taddyUser({ platformUserId: "42", ip: null, userAgent: null, language: "x1", premium: null })).toEqual({ id: 42 });
    expect(taddyUser({ ...REQUESTER, platformUserId: "dev-1" })).toBeNull();
    expect(taddyUser({ ...REQUESTER, platformUserId: "99999999999999999" })).toBeNull();
    expect(taddyUser(null)).toBeNull();
  });

  it("креатив — по pubId сети; чья реклама — сама сеть; без pubId и без игрока — отказ без запроса", async () => {
    const { taddy, creatives } = creativesWith();
    const pubId = "14cbeb980853dd416003462ca4db7c12";
    expect(await creatives.fetch("taddy", { pubId }, REQUESTER)).toEqual({ kind: "creative", creative: { ...CREATIVE, advertiser: "Taddy" } });
    expect(taddy.calls[0]).toMatchObject({ method: "getAd", pubId, user: { id: 777000111, language: "ru" } });
    expect(await creatives.fetch("taddy", {}, REQUESTER)).toEqual({ kind: "none", reason: "misconfigured" });
    expect(await creatives.fetch("taddy", { pubId }, { ...REQUESTER, platformUserId: "dev-7" })).toEqual({ kind: "none", reason: "no_user" });
    expect(await creatives.fetch("adsgram", {}, REQUESTER)).toEqual({ kind: "none", reason: "unsupported" });
    expect(taddy.calls).toHaveLength(1);
  });

  it("отметки — по ключам из базы, даже если сеть уже выключили; без pubId их нет, сбой сети не бросает", async () => {
    const { taddy, creatives } = creativesWith();
    await creatives.shown("taddy", "ad-1", REQUESTER);
    await creatives.viewed("taddy", "ad-1", REQUESTER);
    expect(taddy.calls.map((call) => [call.method, call.extra])).toEqual([
      ["impression", "ad-1"],
      ["viewThrough", "ad-1"],
    ]);

    const empty = creativesWith([{ networkKey: "taddy", keys: {} }]);
    await empty.creatives.shown("taddy", "ad-1", REQUESTER);
    expect(empty.taddy.calls).toEqual([]);

    taddy.failing = true;
    await expect(creatives.shown("taddy", "ad-2", REQUESTER)).resolves.toBeUndefined();
  });
});

describe("учёт аудитории сетью (Р78)", () => {
  const PUB_ID = "14cbeb980853dd416003462ca4db7c12";

  function audienceWith(networks: { networkKey: string; keys: Record<string, string> }[]) {
    const repository = new MemoryAds();
    repository.networks = networks;
    const starts: { pubId: string; user: TaddyUser; startParam: string | null }[] = [];
    const taddy: TaddyApi = {
      getAd: async () => ({ kind: "none", reason: "no_fill" }),
      impression: async () => undefined,
      viewThrough: async () => undefined,
      start: async (pubId, user, startParam) => void starts.push({ pubId, user, startParam }),
    };
    return { starts, audience: new AdAudience(new AdNetworkKeys(repository), taddy) };
  }

  it("SDK на старте — у сети учёта с ключами, включена она или нет; только на её площадке", async () => {
    const { audience } = audienceWith([
      { networkKey: "taddy", keys: { pubId: PUB_ID } },
      { networkKey: "adsgram", keys: {} },
      { networkKey: "richads", keys: { pubId: "1001262", appId: "6023" } },
    ]);
    expect(await audience.launchSetup("telegram")).toEqual([{ network: "taddy", keys: { pubId: PUB_ID } }]);
    expect(await audience.launchSetup("vk")).toEqual([]);
  });

  it("стёртый или кривой ключ — SDK не поднимается", async () => {
    expect(await audienceWith([{ networkKey: "taddy", keys: {} }]).audience.launchSetup("telegram")).toEqual([]);
    expect(await audienceWith([{ networkKey: "taddy", keys: { pubId: "не-ключ" } }]).audience.launchSetup("telegram")).toEqual([]);
    expect(await audienceWith([]).audience.launchSetup("telegram")).toEqual([]);
  });

  it("запуск бота — Taddy с основным подтегом языка; кривой параметр ссылки не уходит; без pubId — ничего", async () => {
    const { audience, starts } = audienceWith([{ networkKey: "taddy", keys: { pubId: PUB_ID } }]);
    await audience.botStarted({ id: 7, language: "pt-BR", premium: true }, "c-promo2026");
    await audience.botStarted({ id: 8, language: null, premium: null }, "ссылка");
    expect(starts).toEqual([
      { pubId: PUB_ID, user: { id: 7, language: "pt", premium: true }, startParam: "c-promo2026" },
      { pubId: PUB_ID, user: { id: 8 }, startParam: null },
    ]);

    const silent = audienceWith([{ networkKey: "taddy", keys: {} }]);
    await silent.audience.botStarted({ id: 7, language: "ru", premium: false }, null);
    expect(silent.starts).toEqual([]);
  });
});

describe("межстраничная по площадкам (WP12, часть 10)", () => {
  const NUMBERS: InterstitialNumbers = { everyRuns: 3, gapMin: 3, newbieRuns: 5, newbieDays: 1, afterPurchaseHours: 24, afterRewardMin: 10 };
  /** Бывалый игрок, которому межстраничная положена: каждое правило ниже ломает ровно одно поле. */
  const READY: InterstitialFacts = { daysSinceSignup: 30, countedRuns: 5, runsSinceShown: 3, lastShownAt: at(NOON, -60), lastPurchaseAt: null, lastRewardedAt: null };
  const rule = (facts: Partial<InterstitialFacts>, numbers: Partial<InterstitialNumbers> = {}, now = NOON) => interstitialRule({ ...NUMBERS, ...numbers }, { ...READY, ...facts }, now);

  it("каждое правило отдельно — и ровно на своей границе", () => {
    expect(rule({})).toBeNull();
    expect(rule({ daysSinceSignup: 0 })).toBe("newbie_days");
    expect(rule({ daysSinceSignup: 1 })).toBeNull();
    expect(rule({ countedRuns: 4 })).toBe("newbie_runs");
    expect(rule({ lastPurchaseAt: at(NOON, -24 * 60 + 1) })).toBe("after_purchase");
    expect(rule({ lastPurchaseAt: at(NOON, -24 * 60) })).toBeNull();
    expect(rule({ lastRewardedAt: at(NOON, -9) })).toBe("after_reward");
    expect(rule({ lastRewardedAt: at(NOON, -10) })).toBeNull();
    expect(rule({ lastShownAt: at(NOON, -2) })).toBe("gap");
    expect(rule({ lastShownAt: at(NOON, -3) })).toBeNull();
    expect(rule({ runsSinceShown: 2 })).toBe("every_runs");
    // Ни одной межстраничной ещё не было — счёт забегов идёт с первого.
    expect(rule({ lastShownAt: null, runsSinceShown: 3 })).toBeNull();
  });

  it("ноль в панели выключает правило, а не держит игрока вечно", () => {
    expect(rule({ daysSinceSignup: 0, countedRuns: 0, runsSinceShown: 3 }, { newbieDays: 0, newbieRuns: 0 })).toBeNull();
    expect(rule({ lastPurchaseAt: at(NOON, -1) }, { afterPurchaseHours: 0 })).toBeNull();
    expect(rule({ lastRewardedAt: at(NOON, -1) }, { afterRewardMin: 0 })).toBeNull();
  });

  it("новичок — пока не прошли и забеги, и дни; отказ называет то, что держит дольше", () => {
    expect(rule({ daysSinceSignup: 0, countedRuns: 0 })).toBe("newbie_days");
    expect(rule({ daysSinceSignup: 3, countedRuns: 0 })).toBe("newbie_runs");
    expect(rule({ lastPurchaseAt: at(NOON, -1), lastShownAt: at(NOON, -1) })).toBe("after_purchase");
  });

  function gated(platform: AdViewer["platform"] = "telegram") {
    const ctx = setup([block("adsgram", 10, { place: "interstitial" })]);
    return { ...ctx, viewer: { ...TELEGRAM, platform } satisfies AdViewer };
  }

  it("граница суток — московская: зарегистрировался в 23:50 — в 23:59 ещё новичок, в 00:00 уже нет", async () => {
    const { service, repository, viewer } = gated();
    const midnight = moscowDayStart(at(NOON, 24 * 60));
    repository.signups.set(ME, at(midnight, -10));
    expect(await service.offer(viewer, "interstitial", at(midnight, -1))).toEqual({ available: false, reason: "policy", retryAt: null });
    expect(await service.offer(viewer, "interstitial", midnight)).toMatchObject({ available: true, format: "interstitial" });
  });

  it("забег короче минуты не считается ни новичку, ни в «каждый N-й»", async () => {
    const { service, repository, viewer } = gated();
    repository.runs.splice(0);
    for (let index = 0; index < 10; index++) repository.runs.push({ accountId: ME, finishedAt: at(NOON, -100 + index), survivalSec: COUNTED_RUN_SEC - 1 });
    expect((await service.offer(viewer, "interstitial", NOON)).available).toBe(false);
    for (let index = 0; index < 5; index++) repository.runs.push({ accountId: ME, finishedAt: at(NOON, -50 + index), survivalSec: COUNTED_RUN_SEC });
    expect((await service.offer(viewer, "interstitial", NOON)).available).toBe(true);
  });

  it("две подряд не бывает: следующая — после N забегов и паузы между показами", async () => {
    const { service, repository, viewer } = gated();
    const first = offered(await service.offer(viewer, "interstitial", NOON));
    await service.report(ME, first.sessionId, { kind: "completed" }, at(NOON, 1));
    // Полчаса спустя, но ни одного забега с показа — не N-й забег.
    expect(await service.offer(viewer, "interstitial", at(NOON, 30))).toMatchObject({ available: false, reason: "policy" });
    // Три минутных забега сразу после показа — но трёх минут с показа ещё нет: держит пауза.
    for (const minute of [1.5, 2, 2.5]) repository.runs.push({ accountId: ME, finishedAt: at(NOON, minute), survivalSec: COUNTED_RUN_SEC });
    expect((await service.offer(viewer, "interstitial", at(NOON, 3.5))).available).toBe(false);
    expect((await service.offer(viewer, "interstitial", at(NOON, 4))).available).toBe(true);
  });

  it("после покупки и ролика за награду — пауза; ролик — только видео за награду, не задание", async () => {
    const { service, repository, viewer } = gated();
    repository.purchases.push({ accountId: ME, paidAt: at(NOON, -60) });
    expect((await service.offer(viewer, "interstitial", NOON)).available).toBe(false);
    expect((await service.offer(viewer, "interstitial", at(NOON, 23 * 60))).available).toBe(true);
    expect(REWARDED_VIDEO_PLACES).toEqual(["second_chance", "wheel_spin", "run_double"]);
  });

  it("ролик за награду на экране держит паузу, а невыданный — нет", async () => {
    const { service, repository, viewer } = gated();
    repository.blocks.push(block("adsonar", 20, { place: "wheel_spin" }));
    const wheel = offered(await service.offer(viewer, "wheel_spin", at(NOON, -5)));
    expect((await service.offer(viewer, "interstitial", NOON)).available).toBe(true);
    await service.report(ME, wheel.sessionId, { kind: "shown" }, at(NOON, -4));
    repository.sessions.splice(repository.sessions.findIndex((session) => session.place === "interstitial"), 1);
    expect((await service.offer(viewer, "interstitial", NOON)).available).toBe(false);
    expect((await service.offer(viewer, "interstitial", at(NOON, 6))).available).toBe(true);
  });

  it("момент — по площадке: Telegram и VK — при старте забега, MAX и веб — никогда", async () => {
    // VK политика пропускает, но AdsGram на VK не работает — рекламы нет, а не «не время».
    for (const [platform, outcome] of [["telegram", "offered"], ["vk", "no_fill"], ["max", "policy"], ["web", "policy"]] as const) {
      const { service, viewer } = gated(platform);
      const offer = await service.offer(viewer, "interstitial", NOON, "run_start");
      expect(offer.available ? "offered" : offer.reason, platform).toBe(outcome);
    }
  });

  it("вне доли флага выката межстраничной нет — ни сессии, ни запроса к сети", async () => {
    const { service, repository, flags, creatives } = setup([block("taddy", 10, { place: "interstitial" })]);
    flags.keys.clear();
    expect(await service.offer(PLAYER, "interstitial", NOON)).toEqual({ available: false, reason: "policy", retryAt: null });
    expect(repository.sessions).toHaveLength(0);
    expect(creatives.requests).toHaveLength(0);
  });

  it("числа — из панели: правка видна на следующей выдаче", async () => {
    const { service, settings, viewer } = gated();
    settings.set("ads.interstitial.newbie-runs", 20);
    expect((await service.offer(viewer, "interstitial", NOON)).available).toBe(false);
    settings.set("ads.interstitial.newbie-runs", 10);
    expect((await service.offer(viewer, "interstitial", NOON)).available).toBe(true);
  });

  it("креатив сети с API для межстраничной ждём меньше: старт забега не ждёт дольше двух секунд", async () => {
    const { service, creatives } = setup([block("taddy", 10), block("taddy", 10, { place: "interstitial" })]);
    offered(await service.offer(PLAYER, "wheel_spin", NOON));
    offered(await service.offer(PLAYER, "interstitial", NOON));
    expect(creatives.requests.map((request) => request.timeoutMs)).toEqual([undefined, INTERSTITIAL_CREATIVE_TIMEOUT_MS]);
    expect(INTERSTITIAL_CREATIVE_TIMEOUT_MS).toBeLessThan(2_000);
  });
});

describe("забор награды хозяином места", () => {
  it("недосмотренное не забирается; досмотренное — однажды, повтор отдаёт ту же сессию для дожима", async () => {
    const { service } = setup([block("adsgram", 10)]);
    const offer = offered(await service.offer(TELEGRAM, "wheel_spin", NOON));
    await expect(service.claim(ME, offer.sessionId, "wheel_spin", NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    await service.report(ME, offer.sessionId, { kind: "completed" }, at(NOON, 1));

    const first = await service.claim(ME, offer.sessionId, "wheel_spin", at(NOON, 1));
    expect(first).toMatchObject({ repeat: false, session: { sessionId: offer.sessionId, status: "claimed", networkKey: "adsgram" } });
    expect(await service.claim(ME, offer.sessionId, "wheel_spin", at(NOON, 2))).toMatchObject({ repeat: true });
  });

  it("чужое место, чужой аккаунт и прошедшее окно забора — не награда", async () => {
    const { service } = setup([block("adsgram", 10)]);
    const offer = offered(await service.offer(TELEGRAM, "wheel_spin", NOON));
    await service.report(ME, offer.sessionId, { kind: "completed" }, NOON);
    await expect(service.claim(ME, offer.sessionId, "run_double", NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    await expect(service.claim(OTHER, offer.sessionId, "wheel_spin", NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    await expect(service.claim(ME, offer.sessionId, "wheel_spin", at(NOON, CLAIM_WINDOW_MIN.view + 1))).rejects.toBeInstanceOf(AdNotCompletedError);
  });

  it("целевое действие, подтверждённое сетью через дни, забирается в своём окне", async () => {
    const { service, repository } = setup([block("taddy", 40, { place: "task" })]);
    const offer = offered(await service.offer(TELEGRAM, "task", NOON));
    repository.confirm(offer.sessionId, at(NOON, 3 * 24 * 60));
    expect(await service.claim(ME, offer.sessionId, "task", at(NOON, 4 * 24 * 60))).toMatchObject({ repeat: false });
  });

  it("две досмотренные сессии, выданные до кулдауна, вторую награду не дают", async () => {
    const { service } = setup([block("adsgram", 10), block("adsonar", 20)]);
    const first = offered(await service.offer(TELEGRAM, "wheel_spin", NOON));
    const second = offered(await service.offer(TELEGRAM, "wheel_spin", NOON));
    for (const offer of [first, second]) await service.report(ME, offer.sessionId, { kind: "completed" }, at(NOON, 1));

    const results = await Promise.allSettled([first, second].map((offer) => service.claim(ME, offer.sessionId, "wheel_spin", at(NOON, 1))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(AdCooldownError);
    expect(rejected?.status === "rejected" && rejected.reason instanceof AdCooldownError ? rejected.reason.retryAt : null).toEqual(at(NOON, 121));
  });
});

describe("реклама без ролика (VIP)", () => {
  /** Пропуск у игрока `ME`: VIP идёт, пока часы не дошли до `until`. */
  function withPass(blocks: AdBlockRow[], until = at(NOON, 24 * 60)) {
    const ctx = setup(blocks);
    const asked: [string, Date][] = [];
    ctx.passes.register("vip", async (accountId, time) => {
      asked.push([accountId, time]);
      return accountId === ME && time < until;
    });
    return { ...ctx, asked };
  }

  it("награда места — сразу: сессия выполнена без сети и ролика, хозяин забирает её как обычную", async () => {
    const { service, repository, asked } = withPass([block("adsgram", 10)]);
    const offer = offered(await service.offer(TELEGRAM, "wheel_spin", NOON));
    // Пропуск ничего не показывает — тестовым ему быть не в чем.
    expect(offer).toMatchObject({ pass: "vip", network: "vip", blockId: null, success: "view", debug: false });
    expect(asked).toEqual([[ME, NOON]]);
    expect(repository.sessions[0]).toMatchObject({ networkKey: "vip", status: "completed", shownAt: null, completedAt: NOON });

    const claimed = await service.claim(ME, offer.sessionId, "wheel_spin", at(NOON, 1));
    expect(claimed).toMatchObject({ repeat: false, session: { networkKey: "vip" } });
    // шагов воронки у сессии без ролика нет
    await expect(service.report(ME, offer.sessionId, { kind: "completed" }, at(NOON, 1))).rejects.toBeInstanceOf(AdSessionClosedError);
  });

  it("сетей в месте нет — VIP всё равно получает награду", async () => {
    const { service } = withPass([]);
    expect(await service.offer(TELEGRAM, "run_double", NOON)).toMatchObject({ available: true, pass: "vip" });
  });

  it("кулдаун места у VIP тот же: пропускается ролик, а не пауза", async () => {
    const { service } = withPass([block("adsgram", 10)]);
    const first = offered(await service.offer(TELEGRAM, "wheel_spin", NOON));
    await service.claim(ME, first.sessionId, "wheel_spin", NOON);
    const cooldown = cooldownMinutes(PLACE_RULES.wheel_spin.cooldown, 1);
    expect(await service.offer(TELEGRAM, "wheel_spin", at(NOON, 1))).toEqual({ available: false, reason: "cooldown", retryAt: at(NOON, cooldown).toISOString() });
    expect(await service.offer(TELEGRAM, "wheel_spin", at(NOON, cooldown))).toMatchObject({ available: true, pass: "vip" });
  });

  it("межстраничной у VIP нет вовсе, у остальных — как раньше", async () => {
    const { service } = withPass([block("adsgram", 10, { place: "interstitial" })]);
    expect(await service.offer(TELEGRAM, "interstitial", NOON)).toEqual({ available: false, reason: "pass", retryAt: null });
    const other: AdViewer = { ...TELEGRAM, accountId: "00000000-0000-4000-8000-00000000ad02" };
    expect(await service.offer(other, "interstitial", NOON)).toMatchObject({ available: true, network: "adsgram", pass: null });
  });

  it("экран хозяина места знает, что ролик не нужен; у межстраничной пропуска нет", async () => {
    const { service } = withPass([]);
    expect(await service.readiness(TELEGRAM, "wheel_spin", NOON)).toEqual({ available: true, readyAt: null, pass: "vip" });
    expect(await service.readiness(TELEGRAM, "interstitial", NOON)).toEqual({ available: false, readyAt: null, pass: null });
  });

  it("VIP кончился — снова сети по кругу, а награда без ролика в истории круг не ломает", async () => {
    const until = at(NOON, 10);
    const { service } = withPass([block("adsgram", 10, { place: "run_double" }), block("adsonar", 20, { place: "run_double" })], until);
    const vip = offered(await service.offer(TELEGRAM, "run_double", NOON));
    await service.claim(ME, vip.sessionId, "run_double", NOON);
    const after = offered(await service.offer(TELEGRAM, "run_double", at(NOON, 60)));
    expect(after).toMatchObject({ network: "adsgram", pass: null });
    await expect(service.claim(ME, after.sessionId, "run_double", at(NOON, 61))).rejects.toBeInstanceOf(AdNotCompletedError);
  });

  it("пропуск — по имени из реестра: кривое имя не регистрируется, первым срабатывает первый зарегистрированный", async () => {
    const passes = new AdPasses();
    expect(() => passes.register("VIP!", async () => true)).toThrow(/имя пропуска/);
    passes.register("vip", async () => false);
    passes.register("promo", async () => true);
    passes.register("later", async () => true);
    expect(await passes.of(ME, NOON)).toBe("promo");
    expect(await new AdPasses().of(ME, NOON)).toBeNull();
  });
});

/** Taddy, который ни на что не отвечает: HTTP-тестам сеть не нужна. */
class FakeTaddyApi implements TaddyApi {
  async getAd() {
    return { kind: "none" as const, reason: "no_fill" as const };
  }
  async impression() {}
  async viewThrough() {}
  async start() {}
}

describe("реклама по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(service: AdsService, audience = new AdAudience(new AdNetworkKeys(new MemoryAds()), new FakeTaddyApi())): Promise<NestFastifyApplication> {
    @Module({
      controllers: [AdsController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: AdsService, useValue: service },
        { provide: AdAudience, useValue: audience },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  it("без токена — 401; место и устройство — из списка, лишнее в теле — 400; площадка — из токена", async () => {
    const { service, repository } = setup([block("adsgram", 10, { platforms: ["telegram"], devices: ["ios"] })]);
    const server = await start(service);
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };

    expect((await server.inject({ method: "POST", url: "/api/v1/ads/sessions", payload: { place: "wheel_spin" } })).statusCode).toBe(401);
    for (const payload of [{ place: "banner" }, { place: "wheel_spin", device: "tv" }, { place: "wheel_spin", platform: "vk" }, {}]) {
      expect((await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }

    const none = await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload: { place: "wheel_spin" } });
    expect(none.json<{ data: AdOffer }>().data).toEqual({ available: false, reason: "no_fill", retryAt: null });

    const offer = await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload: { place: "wheel_spin", device: "ios" } });
    expect(offer.statusCode).toBe(200);
    expect(offer.json<{ data: AdOffer }>().data).toMatchObject({ available: true, network: "adsgram" });
    expect(repository.sessions).toHaveLength(1);
  });

  it("момент — только у межстраничной и у неё обязателен", async () => {
    const { service } = setup([block("adsgram", 10, { place: "interstitial" })]);
    const server = await start(service);
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };
    for (const payload of [{ place: "interstitial" }, { place: "wheel_spin", moment: "run_start" }, { place: "interstitial", moment: "boss_fight" }]) {
      expect((await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const offer = await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload: { place: "interstitial", moment: "run_start" } });
    expect(offer.json<{ data: AdOffer }>().data).toMatchObject({ available: true, format: "interstitial" });
  });

  it("межстраничная — своим лимитом: частые старты забега не отнимают колесо и удвоение", async () => {
    const { service, flags } = setup([block("adsgram", 10)]);
    flags.keys.clear();
    const server = await start(service);
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };
    const interstitial = async () => (await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload: { place: "interstitial", moment: "run_start" } })).statusCode;
    for (let start = 0; start < 60; start++) expect(await interstitial()).toBe(200);
    expect(await interstitial()).toBe(429);
    const wheel = await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload: { place: "wheel_spin", device: "android" } });
    expect(wheel.json<{ data: AdOffer }>().data).toMatchObject({ available: true, network: "adsgram" });
  });

  it("сети для SDK на старте — по токену и площадке из него; без токена — 401", async () => {
    const { service } = setup([]);
    const server = await start(service);
    expect((await server.inject({ method: "GET", url: "/api/v1/ads/networks" })).statusCode).toBe(401);
    const telegram = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const response = await server.inject({ method: "GET", url: "/api/v1/ads/networks", headers: { authorization: `Bearer ${telegram}` } });
    expect(response.json<{ data: unknown }>().data).toEqual({ networks: [{ network: "taddy", keys: { pubId: "14cbeb980853dd416003462ca4db7c12" } }] });
    const vk = await signAccessToken({ accountId: ME, platform: "vk", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    expect((await server.inject({ method: "GET", url: "/api/v1/ads/networks", headers: { authorization: `Bearer ${vk}` } })).json<{ data: unknown }>().data).toEqual({ networks: [] });
  });

  it("сеть с API получает язык и премиум со слов клиента, адрес и браузер — из запроса; кривой язык — 400", async () => {
    const { service, creatives } = setup([block("taddy", 10)]);
    const server = await start(service);
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "777000111" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}`, "user-agent": "Telegram-Android/11" };
    const bad = await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload: { place: "wheel_spin", language: "русский" } });
    expect(bad.statusCode).toBe(400);

    const offer = await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload: { place: "wheel_spin", language: "ru", premium: true } });
    expect(offer.json<{ data: AdOffer }>().data).toMatchObject({ available: true, network: "taddy", creative: { ad: { link: CREATIVE.link } } });
    expect(creatives.requests[0]?.requester).toEqual({ platformUserId: "777000111", ip: "127.0.0.1", userAgent: "Telegram-Android/11", language: "ru", premium: true });
  });

  it("исход показа: идентификатор и исход — по схеме, отказ — с кодом, закрытая сессия — 409 с кодом", async () => {
    const { service } = setup([block("adsgram", 10)]);
    const server = await start(service);
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };
    const offer = offered((await server.inject({ method: "POST", url: "/api/v1/ads/sessions", headers, payload: { place: "wheel_spin" } })).json<{ data: AdOffer }>().data);
    const url = `/api/v1/ads/sessions/${offer.sessionId}/result`;

    expect((await server.inject({ method: "POST", url, payload: { outcome: "shown" } })).statusCode).toBe(401);
    for (const payload of [{ outcome: "rewarded" }, { outcome: "failed" }, { outcome: "failed", reason: "Ошибка сети" }, { outcome: "shown", reward: 100 }]) {
      expect((await server.inject({ method: "POST", url, headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await server.inject({ method: "POST", url: "/api/v1/ads/sessions/short/result", headers, payload: { outcome: "shown" } })).statusCode).toBe(400);

    expect((await server.inject({ method: "POST", url, headers, payload: { outcome: "shown" } })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url, headers, payload: { outcome: "failed", reason: "no_fill" } })).statusCode).toBe(200);
    const closed = await server.inject({ method: "POST", url, headers, payload: { outcome: "completed" } });
    expect(closed.statusCode).toBe(409);
    expect(closed.json<{ error: { code: string } }>().error.code).toBe("ad_session_closed");
  });
});
