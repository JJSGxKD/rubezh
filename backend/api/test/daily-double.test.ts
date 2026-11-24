import "reflect-metadata";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { DailyController } from "../src/modules/daily/daily.controller.js";
import { DailyService } from "../src/modules/daily/daily.service.js";
import { AdDailyCapError, AdNotCompletedError } from "../src/modules/ads/ads-errors.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { PLACE_FORMAT, PLACE_TITLES } from "../src/modules/ads/ad-networks.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AD_PLACES, CAPPED_PLACES, OFFERED_PLACES, PLACE_RULES, isCappedPlace, type AdPlace } from "../src/modules/ads/ads-rules.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import { dailyReward } from "../src/modules/daily/daily-rules.js";
import { DailyAlreadyDoubledError, DailyNotClaimedError } from "../src/modules/daily/daily-double-errors.js";
import { DailyDoubleService, type DailyDoublePlayer } from "../src/modules/daily/daily-double.service.js";
import type { DailyDoubleRecord, DailyDoubleRepository, DailyDoubleRow, DailyRepository, DailyState, RecordOutcome } from "../src/modules/daily/daily.repository.js";
import type { ProgressService } from "../src/modules/progress/progress.service.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeCreatives, MemoryAds, adBlock, interstitialGate } from "./helpers/memory-ads.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Награда дня ×2 за ролик (tasks/T-0242, docs/35-stage4-plan.md Р155): забрав
 * награду дня, игрок удваивает её досмотренной сессией места `daily_double` —
 * один раз в игровые сутки, под дневным капом роликов. Здесь — правила на
 * памяти; одну запись под гонкой и границу суток держит база
 * (`daily-double.integration.test.ts`).
 */

const ME = "00000000-0000-4000-8000-00000000d0d1";
const STRANGER = "00000000-0000-4000-8000-00000000d0d2";
const PLAYER: DailyDoublePlayer = { accountId: ME, platform: "telegram" };
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const NEXT_NOON = new Date(NOON.getTime() + 24 * HOUR);
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);

/** Московские сутки без перехода на летнее время: UTC+3. */
function moscowDay(time: Date): number {
  return Math.floor((time.getTime() + 3 * HOUR) / (24 * HOUR));
}

/** Награда дня в памяти: сколько дней забрано и в какие сутки забран последний. */
class MemoryDaily implements DailyRepository {
  claimedDays = 0;
  lastDay: number | null = null;

  /** забрать день `claimedDays + 1` в сутки `time` */
  claim(time: Date): void {
    this.claimedDays++;
    this.lastDay = moscowDay(time);
  }

  async state(_accountId: string, time: Date): Promise<DailyState> {
    return { claimedDays: this.claimedDays, claimedToday: this.lastDay === moscowDay(time) };
  }

  async advance(_accountId: string, expected: number, time: Date): Promise<boolean> {
    if (this.claimedDays !== expected || this.lastDay === moscowDay(time)) return false;
    this.claim(time);
    return true;
  }
}

/** Таблица `daily_double` в памяти: ключ — игрок и сутки, сессия уникальна; запись атомарна, как `ON CONFLICT DO NOTHING`. */
class MemoryDoubles implements DailyDoubleRepository {
  readonly rows: (DailyDoubleRow & { accountId: string; day: number })[] = [];

  async today(accountId: string, time: Date): Promise<DailyDoubleRow | null> {
    return this.rows.find((row) => row.accountId === accountId && row.day === moscowDay(time)) ?? null;
  }

  async bySession(accountId: string, sessionId: string): Promise<DailyDoubleRow | null> {
    return this.rows.find((row) => row.accountId === accountId && row.sessionId === sessionId) ?? null;
  }

  async record(input: DailyDoubleRecord, time: Date): Promise<RecordOutcome> {
    const day = moscowDay(time);
    const sameDay = this.rows.find((row) => row.accountId === input.accountId && row.day === day);
    const sameSession = this.rows.find((row) => row.sessionId === input.sessionId);
    if (sameDay === undefined && sameSession === undefined) {
      this.rows.push({ accountId: input.accountId, day, gameDay: String(day), dayNumber: input.dayNumber, sessionId: input.sessionId, coins: input.coins, shards: input.shards });
      return "granted";
    }
    return sameDay?.sessionId === input.sessionId ? "repeat" : "taken";
  }
}

class FakeWallet {
  readonly keys = new Set<string>();
  readonly grants: GrantInput[] = [];
  failNext = false;

  async grant(input: GrantInput): Promise<GrantResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("кошелёк недоступен");
    }
    const duplicate = this.keys.has(input.idempotencyKey);
    if (!duplicate) {
      this.keys.add(input.idempotencyKey);
      this.grants.push(input);
    }
    return { credited: duplicate ? 0 : input.amount, balance: 0, duplicate };
  }
}

function setup(options: { level?: number; blocks?: ReturnType<typeof adBlock>[]; settings?: ReturnType<typeof panelSettings> } = {}) {
  const daily = new MemoryDaily();
  const doubles = new MemoryDoubles();
  const wallet = new FakeWallet();
  const progress = { view: async () => ({ level: options.level ?? 1 }) } as unknown as ProgressService;
  const adsRepository = new MemoryAds();
  adsRepository.blocks = options.blocks ?? [adBlock("adsgram", 10, { place: "daily_double" })];
  const passes = new AdPasses();
  const settings = options.settings ?? panelSettings();
  const ads = new AdsService(adsRepository, () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(adsRepository), interstitialGate(adsRepository, settings), restrictionsGate());
  const service = new DailyDoubleService(daily, doubles, progress, wallet as unknown as WalletService, ads, settings);
  return { daily, doubles, wallet, adsRepository, passes, ads, service };
}

type Setup = ReturnType<typeof setup>;

/** Седьмой день недели: 300 монет и 10 осколков на первом уровне. */
function claimedSeventh(env: Setup, time = NOON): void {
  env.daily.claimedDays = 6;
  env.daily.claim(time);
}

/** Реклама места досмотрена: выдача показа и досмотр от SDK. */
async function watched(env: Setup, time = NOON, place: AdPlace = "daily_double"): Promise<string> {
  const offer = await env.ads.offer({ ...PLAYER, device: "android" }, place, time);
  if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
  await env.ads.report(ME, offer.sessionId, { kind: "completed" }, time);
  return offer.sessionId;
}

describe("место «Награда дня ×2» в списках", () => {
  it("правила места: видео за награду, VIP без ролика, кулдауна нет — раз в сутки держит модуль награды дня", () => {
    expect(AD_PLACES).toContain("daily_double");
    expect(PLACE_RULES.daily_double).toEqual({ rewarded: true, pass: true, cooldown: null });
    expect(PLACE_FORMAT.daily_double).toBe("rewarded");
    expect(PLACE_TITLES.daily_double).toBe("Награда дня ×2");
    expect(OFFERED_PLACES).toContain("daily_double");
  });

  it("ролик места идёт в общий дневной кап роликов (T-0241): оно наградное и не задание", () => {
    expect(isCappedPlace("daily_double")).toBe(true);
    expect(CAPPED_PLACES).toContain("daily_double");
  });

  it("клиент и панель знают те же места, что сервер, и в том же порядке", () => {
    const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const listOf = (source: string): string[] => {
      const found = /export const AD_PLACES = \[([^\]]+)\] as const/.exec(source)?.[1] ?? "";
      return [...found.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");
    };
    expect(listOf(read("../../../packages/app-shell/src/state/ads-api.ts"))).toEqual([...AD_PLACES]);
    const panel = read("../../../apps/admin/src/api/ads.ts");
    expect(listOf(panel)).toEqual([...AD_PLACES]);
    expect(panel).toContain('daily_double: "Награда дня ×2"');
  });
});

describe("награда дня ×2 на экране", () => {
  it("сегодня не забрано — удваивать нечего", async () => {
    const { service } = setup();
    expect(await service.view(PLAYER, NOON)).toEqual({ status: "unavailable" });
  });

  it("забрано — числа забранного дня и состояние рекламы места", async () => {
    const env = setup();
    claimedSeventh(env);
    expect(await env.service.view(PLAYER, NOON)).toEqual({
      status: "available",
      coins: 300,
      shards: 10,
      ad: { available: true, readyAt: null, pass: null, capped: false },
    });
  });

  it("числа берёт у забранного дня по тем же правилам: уровень растит монеты, но не осколки", async () => {
    const env = setup({ level: 21 });
    claimedSeventh(env);
    expect(dailyReward(7, 21)).toEqual({ coins: 420, shards: 10 });
    expect(await env.service.view(PLAYER, NOON)).toMatchObject({ status: "available", coins: 420, shards: 10 });
  });

  it("вчерашний забор сегодня не удваивается", async () => {
    const env = setup();
    claimedSeventh(env, NOON);
    expect(await env.service.view(PLAYER, NEXT_NOON)).toEqual({ status: "unavailable" });
    expect(await env.service.view(PLAYER, at(NEXT_NOON, 60 * 11))).toEqual({ status: "unavailable" });
  });

  it("удвоено — «удвоено» с начисленными числами, кнопки нет", async () => {
    const env = setup();
    claimedSeventh(env);
    await env.service.double(PLAYER, await watched(env), NOON);
    expect(await env.service.view(PLAYER, at(NOON, 5))).toEqual({ status: "doubled", coins: 300, shards: 10 });
  });

  it("рекламы для площадки нет — экран это знает и кнопки не покажет", async () => {
    const env = setup({ blocks: [] });
    claimedSeventh(env);
    expect(await env.service.view(PLAYER, NOON)).toMatchObject({ status: "available", ad: { available: false, capped: false, pass: null } });
  });

  it("VIP удваивает без ролика, даже когда сетей нет", async () => {
    const env = setup({ blocks: [] });
    env.passes.register("vip", async () => true);
    claimedSeventh(env);
    expect(await env.service.view(PLAYER, NOON)).toMatchObject({ ad: { available: true, pass: "vip", capped: false } });
  });

  it("дневной кап роликов достигнут — ad.capped, и кнопка не молчит", async () => {
    const env = setup({ settings: panelSettings({ "ads.rewarded.daily-cap": 1 }) });
    claimedSeventh(env);
    await watched(env, NOON, "daily_double");
    expect(await env.service.view(PLAYER, at(NOON, 2))).toMatchObject({ status: "available", ad: { available: false, capped: true } });
  });
});

describe("удвоение", () => {
  it("забор седьмого дня, ролик — и ещё столько же: монеты и осколки с причиной награды дня, ключом дня", async () => {
    const env = setup();
    claimedSeventh(env);
    const sessionId = await watched(env);
    const result = await env.service.double(PLAYER, sessionId, NOON);

    expect(result.credited).toEqual({ coins: 300, shards: 10 });
    expect(result.view).toEqual({ status: "doubled", coins: 300, shards: 10 });
    expect(env.wallet.grants).toEqual([
      { accountId: ME, resource: "coins", amount: 300, reason: "daily_reward", source: "daily:7:double", idempotencyKey: `daily:${ME}:7:double`, at: NOON },
      { accountId: ME, resource: "shard_common", amount: 10, reason: "daily_reward", source: "daily:7:double", idempotencyKey: `daily:${ME}:7:double:shards`, at: NOON },
    ]);
    expect(env.doubles.rows).toHaveLength(1);
    expect(env.doubles.rows[0]).toMatchObject({ dayNumber: 7, sessionId, coins: 300, shards: 10 });
  });

  it("день без осколков — только монеты, пустого начисления нет", async () => {
    const env = setup();
    env.daily.claim(NOON);
    const result = await env.service.double(PLAYER, await watched(env), NOON);
    expect(result.credited).toEqual({ coins: dailyReward(1, 1).coins, shards: 0 });
    expect(env.wallet.grants.map((grant) => grant.resource)).toEqual(["coins"]);
  });

  it("повтор той же сессией — тот же ответ, второго начисления нет", async () => {
    const env = setup();
    claimedSeventh(env);
    const sessionId = await watched(env);
    const first = await env.service.double(PLAYER, sessionId, NOON);
    const again = await env.service.double(PLAYER, sessionId, at(NOON, 1));
    expect(again).toEqual(first);
    expect(env.wallet.grants).toHaveLength(2);
    expect(env.doubles.rows).toHaveLength(1);
  });

  it("обрыв после записи: повтор той же сессией дожимает начисление тем же ключом, а не отказывает", async () => {
    const env = setup();
    claimedSeventh(env);
    const sessionId = await watched(env);
    env.wallet.failNext = true;
    await expect(env.service.double(PLAYER, sessionId, NOON)).rejects.toThrow(/кошелёк недоступен/);
    expect(env.wallet.grants).toHaveLength(0);

    const retry = await env.service.double(PLAYER, sessionId, at(NOON, 1));
    expect(retry.credited).toEqual({ coins: 300, shards: 10 });
    expect(env.wallet.grants).toHaveLength(2);
    expect(env.wallet.grants[0]?.idempotencyKey).toBe(`daily:${ME}:7:double`);
    expect(env.doubles.rows).toHaveLength(1);
  });

  it("обрыв между монетами и осколками: дожим не удваивает монеты", async () => {
    const env = setup();
    claimedSeventh(env);
    const sessionId = await watched(env);
    const original = env.wallet.grant.bind(env.wallet);
    let calls = 0;
    env.wallet.grant = async (input) => {
      if (++calls === 2) throw new Error("кошелёк недоступен");
      return await original(input);
    };
    await expect(env.service.double(PLAYER, sessionId, NOON)).rejects.toThrow(/кошелёк недоступен/);
    await env.service.double(PLAYER, sessionId, at(NOON, 1));
    expect(env.wallet.grants.map((grant) => [grant.resource, grant.amount])).toEqual([
      ["coins", 300],
      ["shard_common", 10],
    ]);
  });

  it("вторая сессия в тот же день — 409 «уже удвоено», и досмотренная сессия не потрачена", async () => {
    const env = setup({ blocks: [adBlock("adsgram", 10, { place: "daily_double" }), adBlock("richads", 20, { place: "daily_double" })] });
    claimedSeventh(env);
    const first = await watched(env);
    const second = await watched(env);
    await env.service.double(PLAYER, first, NOON);

    const error = await env.service.double(PLAYER, second, at(NOON, 1)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DailyAlreadyDoubledError);
    expect(error).toMatchObject({ code: "daily_already_doubled", status: 409 });
    expect(env.wallet.grants).toHaveLength(2);
    expect(env.adsRepository.sessions.find((session) => session.sessionId === second)?.claimedAt).toBeNull();
  });

  it("до забора награды — 409 «не забрано», сессия не потрачена и годится после забора", async () => {
    const env = setup();
    const sessionId = await watched(env);
    const error = await env.service.double(PLAYER, sessionId, NOON).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DailyNotClaimedError);
    expect(error).toMatchObject({ code: "daily_not_claimed", status: 409 });
    expect(env.adsRepository.sessions.find((session) => session.sessionId === sessionId)?.claimedAt).toBeNull();
    expect(env.wallet.grants).toHaveLength(0);

    claimedSeventh(env, at(NOON, 2));
    await expect(env.service.double(PLAYER, sessionId, at(NOON, 3))).resolves.toMatchObject({ credited: { coins: 300, shards: 10 } });
  });

  it("забор был вчера — сегодня удвоить нельзя: удвоение того дня сгорело, копить нельзя", async () => {
    const env = setup();
    claimedSeventh(env, NOON);
    const sessionId = await watched(env, NEXT_NOON);
    await expect(env.service.double(PLAYER, sessionId, NEXT_NOON)).rejects.toBeInstanceOf(DailyNotClaimedError);
    expect(env.wallet.grants).toHaveLength(0);
  });

  it("новые сутки — новый забор и новое удвоение: восьмой день, ключ и источник свои", async () => {
    const env = setup();
    claimedSeventh(env, NOON);
    await env.service.double(PLAYER, await watched(env, NOON), NOON);

    env.daily.claim(NEXT_NOON);
    const result = await env.service.double(PLAYER, await watched(env, NEXT_NOON), NEXT_NOON);
    expect(result.credited).toEqual({ coins: dailyReward(8, 1).coins, shards: 0 });
    expect(env.wallet.grants.at(-1)).toMatchObject({ source: "daily:8:double", idempotencyKey: `daily:${ME}:8:double` });
    expect(env.doubles.rows).toHaveLength(2);
  });

  it("чужая сессия не годится: ошибка модуля рекламы, ничего не начислено", async () => {
    const env = setup();
    claimedSeventh(env);
    const offer = await env.ads.offer({ accountId: STRANGER, platform: "telegram", device: "android" }, "daily_double", NOON);
    if (!offer.available) throw new Error("показа нет");
    await env.ads.report(STRANGER, offer.sessionId, { kind: "completed" }, NOON);
    await expect(env.service.double(PLAYER, offer.sessionId, NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(env.wallet.grants).toHaveLength(0);
    expect(env.doubles.rows).toHaveLength(0);
  });

  it("сессия чужого места не годится: колесо не удваивает награду дня", async () => {
    const env = setup({ blocks: [adBlock("adsgram", 10, { place: "daily_double" }), adBlock("adsgram", 10, { place: "wheel_spin" })] });
    claimedSeventh(env);
    const wheel = await watched(env, NOON, "wheel_spin");
    await expect(env.service.double(PLAYER, wheel, NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(env.wallet.grants).toHaveLength(0);
  });

  it("недосмотренная сессия не годится, и не выдуманная тоже", async () => {
    const env = setup();
    claimedSeventh(env);
    const offer = await env.ads.offer({ ...PLAYER, device: "android" }, "daily_double", NOON);
    if (!offer.available) throw new Error("показа нет");
    await expect(env.service.double(PLAYER, offer.sessionId, NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    await expect(env.service.double(PLAYER, "AAAAAAAAAAAAAAAA", NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(env.wallet.grants).toHaveLength(0);
  });

  it("VIP удваивает без ролика: сессия приходит выполненной, число то же", async () => {
    const env = setup({ blocks: [] });
    env.passes.register("vip", async () => true);
    claimedSeventh(env);
    const offer = await env.ads.offer({ ...PLAYER, device: null }, "daily_double", NOON);
    if (!offer.available) throw new Error("показа нет");
    expect(offer.pass).toBe("vip");
    const result = await env.service.double(PLAYER, offer.sessionId, NOON);
    expect(result.credited).toEqual({ coins: 300, shards: 10 });
    expect(env.doubles.rows).toHaveLength(1);
  });

  it("дневной кап роликов: забор сверх капа — 409 «ролики кончились», ничего не записано и не начислено", async () => {
    const env = setup({ settings: panelSettings({ "ads.rewarded.daily-cap": 1 }) });
    claimedSeventh(env);
    const sessionId = await watched(env);
    // Кап уже выбран: другой ролик, выданный до этого, забран хозяином своего места.
    const other = "cap-other-session1";
    await env.adsRepository.createSession({ sessionId: other, accountId: ME, place: "wheel_spin", block: adBlock("adsgram", 10, { place: "wheel_spin" }), creative: null, createdAt: NOON, expiresAt: at(NOON, 30) });
    await env.adsRepository.report(other, ME, { kind: "completed" }, at(NOON, 1));
    await env.ads.claim(ME, other, "wheel_spin", at(NOON, 1));

    await expect(env.service.double(PLAYER, sessionId, at(NOON, 1))).rejects.toBeInstanceOf(AdDailyCapError);
    expect(env.doubles.rows).toHaveLength(0);
    expect(env.wallet.grants).toHaveLength(0);
  });

  it("два запроса разом разными сессиями: удвоено один раз, второй получает «уже удвоено»", async () => {
    const env = setup({ blocks: [adBlock("adsgram", 10, { place: "daily_double" }), adBlock("richads", 20, { place: "daily_double" })] });
    claimedSeventh(env);
    const [first, second] = [await watched(env), await watched(env)];
    const results = await Promise.allSettled([env.service.double(PLAYER, first, NOON), env.service.double(PLAYER, second, NOON)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(DailyAlreadyDoubledError);
    expect(env.doubles.rows).toHaveLength(1);
    expect(env.wallet.grants).toHaveLength(2);
  });

  it("два запроса разом одной сессией: одно начисление, оба получают ответ", async () => {
    const env = setup();
    claimedSeventh(env);
    const sessionId = await watched(env);
    const results = await Promise.all([env.service.double(PLAYER, sessionId, NOON), env.service.double(PLAYER, sessionId, NOON)]);
    expect(results[0]?.credited).toEqual({ coins: 300, shards: 10 });
    expect(results[1]?.view).toEqual({ status: "doubled", coins: 300, shards: 10 });
    expect(env.doubles.rows).toHaveLength(1);
    expect(env.wallet.grants).toHaveLength(2);
  });

  it("потолок причины награды дня: самый щедрый день, удвоенный, укладывается в суточный потолок кошелька", () => {
    const richest = dailyReward(35, 100);
    expect(richest.coins * 2).toBeLessThan(5_000);
    expect(richest.shards * 2).toBeLessThan(100);
  });
});

describe("награда дня ×2 по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(env: Setup): Promise<NestFastifyApplication> {
    const daily = new DailyService(env.daily, { view: async () => ({ level: 1 }) } as unknown as ProgressService, env.wallet as unknown as WalletService);
    @Module({
      controllers: [DailyController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: DailyService, useValue: daily },
        { provide: DailyDoubleService, useValue: env.service },
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

  it("без токена — 401; кривое тело — 400; до забора — 409 daily_not_claimed; после забора — удвоение и «удвоено»; вторая сессия — 409", async () => {
    const env = setup({ blocks: [adBlock("adsgram", 10, { place: "daily_double" }), adBlock("richads", 20, { place: "daily_double" })] });
    const server = await start(env);
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };
    const double = (payload: unknown) => server.inject({ method: "POST", url: "/api/v1/daily/double", headers, payload: payload as object });
    const session = () => watched(env, new Date());

    expect((await server.inject({ method: "GET", url: "/api/v1/daily" })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/api/v1/daily/double", payload: { sessionId: "AAAAAAAAAAAAAAAA" } })).statusCode).toBe(401);
    for (const payload of [{}, { sessionId: "short" }, { sessionId: "AAAAAAAAAAAAAAAA", extra: 1 }, { sessionId: 7 }]) {
      expect((await double(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }

    const before = await server.inject({ method: "GET", url: "/api/v1/daily", headers });
    expect(before.json<{ data: { canClaim: boolean; double: unknown } }>().data).toMatchObject({ canClaim: true, double: { status: "unavailable" } });
    const early = await double({ sessionId: await session() });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ error: { code: string } }>().error.code).toBe("daily_not_claimed");

    const claimed = await server.inject({ method: "POST", url: "/api/v1/daily/claim", headers });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json<{ data: { claimed: boolean; view: { double: unknown } } }>().data).toMatchObject({ claimed: true, view: { double: { status: "available", coins: 60, shards: 0 } } });

    const first = await session();
    const result = await double({ sessionId: first });
    expect(result.statusCode).toBe(200);
    expect(result.json<{ data: unknown }>().data).toEqual({ credited: { coins: 60, shards: 0 }, view: { status: "doubled", coins: 60, shards: 0 } });
    const after = await server.inject({ method: "GET", url: "/api/v1/daily", headers });
    expect(after.json<{ data: { double: unknown } }>().data.double).toEqual({ status: "doubled", coins: 60, shards: 0 });

    const second = await double({ sessionId: await session() });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("daily_already_doubled");
    expect((await double({ sessionId: first })).statusCode).toBe(200);
    expect(env.wallet.grants.filter((grant) => grant.source === "daily:1:double")).toHaveLength(1);
  });
});
