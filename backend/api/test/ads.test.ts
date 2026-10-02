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
  nextAllowedAt,
  nextRewardAt,
  placeState,
  type AdPlace,
  type PlaceHistoryEntry,
} from "../src/modules/ads/ads-rules.js";
import type { AdBlockRow } from "../src/modules/ads/ads.repository.js";
import { AdsController } from "../src/modules/ads/ads.controller.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdsService, eligibleBlocks, type AdOffer, type AdViewer, type AdsRoll } from "../src/modules/ads/ads.service.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAds, adBlock as block, moscowDayStart } from "./helpers/memory-ads.js";
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

const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);

/** Бросок по очереди из списка — какой блок сети выпадет, решает тест. */
function rolls(...values: number[]): AdsRoll {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

function setup(blocks: AdBlockRow[], roll: AdsRoll = rolls(0)) {
  const repository = new MemoryAds();
  repository.blocks = blocks;
  const passes = new AdPasses();
  const settings = panelSettings();
  return { repository, passes, settings, service: new AdsService(repository, roll, passes, settings) };
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
    expect(state.lastShownAt).toEqual(at(NOON, -199));
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
    expect(nextAllowedAt("wheel_spin", state, at(midnight, 10))).toEqual(at(lateNight, 270));
  });

  it("межстраничная — не чаще промежутка, но забору награды промежуток не мешает", () => {
    const state = placeState([entry("adsgram", at(NOON, -2), { shownAt: at(NOON, -2) })], moscowDayStart(NOON), NOON);
    expect(nextAllowedAt("interstitial", state, NOON)).toEqual(at(NOON, 1));
    expect(nextAllowedAt("interstitial", state, at(NOON, 1))).toBeNull();
    expect(nextRewardAt("interstitial", state, NOON)).toBeNull();
    expect(nextAllowedAt("wheel_spin", state, NOON)).toBeNull();
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

  it("блоки места — по площадке и устройству; пустой список — везде, неизвестное устройство — только туда, где не ограничено", () => {
    const everywhere = block("adsgram", 10);
    const vkOnly = block("adsonar", 20, { platforms: ["vk"] });
    const mobile = block("richads", 30, { devices: ["android", "ios"] });
    const otherPlace = block("taddy", 40, { place: "run_double" });
    const all = [everywhere, vkOnly, mobile, otherPlace];
    expect(eligibleBlocks(all, "wheel_spin", { platform: "telegram", device: "android" })).toEqual([everywhere, mobile]);
    expect(eligibleBlocks(all, "wheel_spin", { platform: "vk", device: "desktop" })).toEqual([everywhere, vkOnly]);
    expect(eligibleBlocks(all, "wheel_spin", { platform: "telegram", device: null })).toEqual([everywhere]);
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

describe("реклама по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(service: AdsService): Promise<NestFastifyApplication> {
    @Module({
      controllers: [AdsController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: AdsService, useValue: service },
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
