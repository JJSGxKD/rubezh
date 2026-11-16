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
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { PLACE_FORMAT, PLACE_TITLES } from "../src/modules/ads/ad-networks.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdDailyCapError, AdNotCompletedError } from "../src/modules/ads/ads-errors.js";
import { AD_PLACES, CAPPED_PLACES, OFFERED_PLACES, PLACE_RULES, isCappedPlace, type AdPlace } from "../src/modules/ads/ads-rules.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { FreeGemsService, type FreeGemsPlayer } from "../src/modules/shop/free-gems.service.js";
import type { FreeGemsRecord, FreeGemsRepository, FreeGemsRow, RecordOutcome } from "../src/modules/shop/free-gems.repository.js";
import { FreeGemsClaimedError } from "../src/modules/shop/shop-errors.js";
import { ShopController } from "../src/modules/shop/shop.controller.js";
import { ShopService } from "../src/modules/shop/shop.service.js";
import { ShowcaseService } from "../src/modules/shop/showcase.service.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeCreatives, MemoryAds, adBlock, interstitialGate } from "./helpers/memory-ads.js";
import { restrictionsGate } from "./helpers/memory-restrictions.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Самоцветы за ролик раз в игровые сутки (tasks/T-0243, docs/35-stage4-plan.md
 * Р155): магазин — хозяин места рекламы `free_gems`. Игрок досматривает ролик
 * и берёт несколько самоцветов, раз в игровые сутки, под дневным капом роликов.
 * Здесь — правила на памяти; одну запись под гонкой и границу суток держит
 * база (`free-gems.integration.test.ts`).
 */

const ME = "00000000-0000-4000-8000-0000000f3e01";
const STRANGER = "00000000-0000-4000-8000-0000000f3e02";
const PLAYER: FreeGemsPlayer = { accountId: ME, platform: "telegram" };
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const NEXT_NOON = new Date(NOON.getTime() + 24 * HOUR);
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MINUTE);
const AMOUNT_KEY = "ads.free-gems.amount";
const CAP_KEY = "ads.rewarded.daily-cap";

/** Московские сутки без перехода на летнее время: UTC+3. */
function moscowDay(time: Date): number {
  return Math.floor((time.getTime() + 3 * HOUR) / (24 * HOUR));
}

/** Игровые сутки в виде, который отдаёт база: `ГГГГ-ММ-ДД`. */
function dayText(day: number): string {
  return new Date(day * 24 * HOUR).toISOString().slice(0, 10);
}

/** Таблица `free_gems_claim` в памяти: ключ — игрок и сутки, сессия уникальна; запись атомарна, как `ON CONFLICT DO NOTHING`. */
class MemoryFreeGems implements FreeGemsRepository {
  readonly rows: (FreeGemsRow & { accountId: string; day: number })[] = [];

  async today(accountId: string, time: Date): Promise<FreeGemsRow | null> {
    return this.rows.find((row) => row.accountId === accountId && row.day === moscowDay(time)) ?? null;
  }

  async bySession(accountId: string, sessionId: string): Promise<FreeGemsRow | null> {
    return this.rows.find((row) => row.accountId === accountId && row.sessionId === sessionId) ?? null;
  }

  async record(input: FreeGemsRecord, time: Date): Promise<RecordOutcome> {
    const day = moscowDay(time);
    const sameDay = this.rows.find((row) => row.accountId === input.accountId && row.day === day);
    const sameSession = this.rows.find((row) => row.sessionId === input.sessionId);
    if (sameDay === undefined && sameSession === undefined) {
      this.rows.push({ accountId: input.accountId, day, gameDay: dayText(day), sessionId: input.sessionId, gems: input.gems });
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

function setup(options: { blocks?: ReturnType<typeof adBlock>[]; settings?: ReturnType<typeof panelSettings> } = {}) {
  const claims = new MemoryFreeGems();
  const wallet = new FakeWallet();
  const adsRepository = new MemoryAds();
  adsRepository.blocks = options.blocks ?? [adBlock("adsgram", 10, { place: "free_gems" })];
  const passes = new AdPasses();
  const settings = options.settings ?? panelSettings();
  const ads = new AdsService(adsRepository, () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(adsRepository), interstitialGate(adsRepository, settings), restrictionsGate());
  const service = new FreeGemsService(claims, wallet as unknown as WalletService, ads, settings);
  return { claims, wallet, adsRepository, passes, ads, service, settings };
}

type Setup = ReturnType<typeof setup>;

/** Реклама места досмотрена: выдача показа и досмотр от SDK. */
async function watched(env: Setup, time = NOON, place: AdPlace = "free_gems"): Promise<string> {
  const offer = await env.ads.offer({ ...PLAYER, device: "android" }, place, time);
  if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
  await env.ads.report(ME, offer.sessionId, { kind: "completed" }, time);
  return offer.sessionId;
}

describe("место «Самоцветы за ролик» в списках", () => {
  it("правила места: видео за награду, VIP без ролика, кулдауна нет — раз в сутки держит магазин", () => {
    expect(AD_PLACES).toContain("free_gems");
    expect(PLACE_RULES.free_gems).toEqual({ rewarded: true, pass: true, cooldown: null });
    expect(PLACE_FORMAT.free_gems).toBe("rewarded");
    expect(PLACE_TITLES.free_gems).toBe("Самоцветы за ролик");
    expect(OFFERED_PLACES).toContain("free_gems");
  });

  it("ролик места идёт в общий дневной кап роликов (T-0241): оно наградное и не задание", () => {
    expect(isCappedPlace("free_gems")).toBe(true);
    expect(CAPPED_PLACES).toContain("free_gems");
  });

  it("клиент и панель знают те же места, что сервер, и в том же порядке; панель называет место словами", () => {
    const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const listOf = (source: string): string[] => {
      const found = /export const AD_PLACES = \[([^\]]+)\] as const/.exec(source)?.[1] ?? "";
      return [...found.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");
    };
    expect(listOf(read("../../../packages/app-shell/src/state/ads-api.ts"))).toEqual([...AD_PLACES]);
    const panel = read("../../../apps/admin/src/api/ads.ts");
    expect(listOf(panel)).toEqual([...AD_PLACES]);
    expect(panel).toContain('free_gems: "Самоцветы за ролик"');
  });

  it("Prisma-перечисление мест и миграция знают место", () => {
    const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8");
    const enumBody = /enum AdPlace \{([^}]+)\}/.exec(schema)?.[1] ?? "";
    expect(enumBody).toMatch(/^\s*free_gems\s*$/m);
  });
});

describe("сколько самоцветов — ключ панели и потолок кошелька", () => {
  it("ключ ads.free-gems.amount: по умолчанию 5, целое от 1 до 20", () => {
    const setting = SETTINGS.adsFreeGemsAmount;
    expect(setting.key).toBe(AMOUNT_KEY);
    expect(setting.fallback).toBe(5);
    for (const bad of [0, 21, -1, 1.5, "5"]) expect(setting.schema.safeParse(bad).success, String(bad)).toBe(false);
    for (const good of [1, 5, 20]) expect(setting.schema.safeParse(good).success, String(good)).toBe(true);
  });

  it("потолок причины «ad_reward» по самоцветам — верх ключа: 20 в игровые сутки", () => {
    expect(WALLET_DAILY_CAPS.ad_reward.gems).toBe(20);
    expect(WALLET_DAILY_CAPS.ad_reward.gems).toBe(SETTINGS.adsFreeGemsAmount.range?.max);
  });
});

describe("самоцветы за ролик на витрине", () => {
  it("сегодня не взято — «доступно» с числом из ключа и состоянием рекламы места", async () => {
    const { service } = setup();
    expect(await service.view(PLAYER, NOON)).toEqual({
      status: "available",
      gems: 5,
      ad: { available: true, readyAt: null, pass: null, capped: false },
    });
  });

  it("число меняется в панели и видно на следующем запросе", async () => {
    const env = setup();
    env.settings.set(AMOUNT_KEY, 12);
    expect(await env.service.view(PLAYER, NOON)).toMatchObject({ status: "available", gems: 12 });
  });

  it("взято — «взято» с числом, которое легло, а не с сегодняшним ключом", async () => {
    const env = setup();
    await env.service.claim(PLAYER, await watched(env), NOON);
    env.settings.set(AMOUNT_KEY, 9);
    expect(await env.service.view(PLAYER, at(NOON, 5))).toEqual({ status: "claimed", gems: 5 });
  });

  it("новые сутки — снова «доступно»", async () => {
    const env = setup();
    await env.service.claim(PLAYER, await watched(env), NOON);
    expect(await env.service.view(PLAYER, NEXT_NOON)).toMatchObject({ status: "available", gems: 5 });
  });

  it("рекламы для площадки нет — «недоступно», карточку не рисуют", async () => {
    const env = setup({ blocks: [] });
    expect(await env.service.view(PLAYER, NOON)).toEqual({ status: "unavailable" });
  });

  it("VIP берёт без ролика, даже когда сетей нет", async () => {
    const env = setup({ blocks: [] });
    env.passes.register("vip", async () => true);
    expect(await env.service.view(PLAYER, NOON)).toEqual({ status: "available", gems: 5, ad: { available: true, readyAt: null, pass: "vip", capped: false } });
  });

  it("дневной кап роликов достигнут — «доступно» с ad.capped, и кнопка не молчит", async () => {
    const env = setup({ settings: panelSettings({ [CAP_KEY]: 1 }) });
    await watched(env, NOON, "free_gems");
    expect(await env.service.view(PLAYER, at(NOON, 2))).toMatchObject({ status: "available", ad: { available: false, capped: true } });
  });
});

describe("взять самоцветы", () => {
  it("ролик, запрос — +5 самоцветов: причина «ad_reward», ключ суток, запись в таблице", async () => {
    const env = setup();
    const sessionId = await watched(env);
    const result = await env.service.claim(PLAYER, sessionId, NOON);

    expect(result.credited).toBe(5);
    expect(result.view).toEqual({ status: "claimed", gems: 5 });
    expect(env.wallet.grants).toEqual([{ accountId: ME, resource: "gems", amount: 5, reason: "ad_reward", source: "free_gems:2026-09-30", idempotencyKey: `free_gems:${ME}:2026-09-30`, at: NOON }]);
    expect(env.claims.rows).toHaveLength(1);
    expect(env.claims.rows[0]).toMatchObject({ sessionId, gems: 5, gameDay: "2026-09-30" });
  });

  it("ключ 10 — +10; ключ 1 — +1", async () => {
    const env = setup({ settings: panelSettings({ [AMOUNT_KEY]: 10 }) });
    expect((await env.service.claim(PLAYER, await watched(env), NOON)).credited).toBe(10);
    const low = setup({ settings: panelSettings({ [AMOUNT_KEY]: 1 }) });
    expect((await low.service.claim(PLAYER, await watched(low), NOON)).credited).toBe(1);
  });

  it("повтор той же сессией — тот же ответ и то же число, даже если ключ уже другой; второго начисления нет", async () => {
    const env = setup();
    const sessionId = await watched(env);
    const first = await env.service.claim(PLAYER, sessionId, NOON);
    env.settings.set(AMOUNT_KEY, 20);
    const again = await env.service.claim(PLAYER, sessionId, at(NOON, 1));
    expect(again).toEqual(first);
    expect(env.wallet.grants).toHaveLength(1);
    expect(env.claims.rows).toHaveLength(1);
  });

  it("обрыв после записи: повтор той же сессией дожимает начисление тем же ключом, а не отказывает", async () => {
    const env = setup();
    const sessionId = await watched(env);
    env.wallet.failNext = true;
    await expect(env.service.claim(PLAYER, sessionId, NOON)).rejects.toThrow(/кошелёк недоступен/);
    expect(env.wallet.grants).toHaveLength(0);

    const retry = await env.service.claim(PLAYER, sessionId, at(NOON, 1));
    expect(retry.credited).toBe(5);
    expect(env.wallet.grants).toHaveLength(1);
    expect(env.wallet.grants[0]?.idempotencyKey).toBe(`free_gems:${ME}:2026-09-30`);
    expect(env.claims.rows).toHaveLength(1);
  });

  it("повтор после обрыва берёт число записи, а не изменившегося ключа", async () => {
    const env = setup();
    const sessionId = await watched(env);
    env.wallet.failNext = true;
    await expect(env.service.claim(PLAYER, sessionId, NOON)).rejects.toThrow(/кошелёк недоступен/);
    env.settings.set(AMOUNT_KEY, 20);
    expect((await env.service.claim(PLAYER, sessionId, at(NOON, 1))).credited).toBe(5);
  });

  it("второй раз в те же сутки другой сессией — 409 «уже взято», и досмотренная сессия не потрачена", async () => {
    const env = setup({ blocks: [adBlock("adsgram", 10, { place: "free_gems" }), adBlock("richads", 20, { place: "free_gems" })] });
    const first = await watched(env);
    const second = await watched(env);
    await env.service.claim(PLAYER, first, NOON);

    const error = await env.service.claim(PLAYER, second, at(NOON, 1)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FreeGemsClaimedError);
    expect(error).toMatchObject({ code: "free_gems_claimed", status: 409 });
    expect(env.wallet.grants).toHaveLength(1);
    expect(env.adsRepository.sessions.find((session) => session.sessionId === second)?.claimedAt).toBeNull();
  });

  it("новые сутки — снова можно: ключ и источник свои, записей две", async () => {
    const env = setup();
    await env.service.claim(PLAYER, await watched(env, NOON), NOON);
    const result = await env.service.claim(PLAYER, await watched(env, NEXT_NOON), NEXT_NOON);
    expect(result.credited).toBe(5);
    expect(env.wallet.grants.at(-1)).toMatchObject({ source: "free_gems:2026-10-01", idempotencyKey: `free_gems:${ME}:2026-10-01` });
    expect(env.claims.rows).toHaveLength(2);
  });

  it("чужая сессия не годится: ошибка модуля рекламы, ничего не начислено", async () => {
    const env = setup();
    const offer = await env.ads.offer({ accountId: STRANGER, platform: "telegram", device: "android" }, "free_gems", NOON);
    if (!offer.available) throw new Error("показа нет");
    await env.ads.report(STRANGER, offer.sessionId, { kind: "completed" }, NOON);
    await expect(env.service.claim(PLAYER, offer.sessionId, NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(env.wallet.grants).toHaveLength(0);
    expect(env.claims.rows).toHaveLength(0);
  });

  it("сессия чужого места не годится: колесо не даёт самоцветов", async () => {
    const env = setup({ blocks: [adBlock("adsgram", 10, { place: "free_gems" }), adBlock("adsgram", 10, { place: "wheel_spin" })] });
    const wheel = await watched(env, NOON, "wheel_spin");
    await expect(env.service.claim(PLAYER, wheel, NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(env.wallet.grants).toHaveLength(0);
  });

  it("недосмотренная сессия не годится, и не выдуманная тоже", async () => {
    const env = setup();
    const offer = await env.ads.offer({ ...PLAYER, device: "android" }, "free_gems", NOON);
    if (!offer.available) throw new Error("показа нет");
    await expect(env.service.claim(PLAYER, offer.sessionId, NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    await expect(env.service.claim(PLAYER, "AAAAAAAAAAAAAAAA", NOON)).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(env.wallet.grants).toHaveLength(0);
    expect(env.claims.rows).toHaveLength(0);
  });

  it("VIP берёт без ролика: сессия приходит выполненной, число то же", async () => {
    const env = setup({ blocks: [] });
    env.passes.register("vip", async () => true);
    const offer = await env.ads.offer({ ...PLAYER, device: null }, "free_gems", NOON);
    if (!offer.available) throw new Error("показа нет");
    expect(offer.pass).toBe("vip");
    expect((await env.service.claim(PLAYER, offer.sessionId, NOON)).credited).toBe(5);
    expect(env.claims.rows).toHaveLength(1);
  });

  it("дневной кап роликов: забор сверх капа — 409 «ролики кончились», ничего не записано и не начислено", async () => {
    const env = setup({ settings: panelSettings({ [CAP_KEY]: 1 }) });
    const sessionId = await watched(env);
    const other = "cap-other-session1";
    await env.adsRepository.createSession({ sessionId: other, accountId: ME, place: "wheel_spin", block: adBlock("adsgram", 10, { place: "wheel_spin" }), creative: null, createdAt: NOON, expiresAt: at(NOON, 30) });
    await env.adsRepository.report(other, ME, { kind: "completed" }, at(NOON, 1));
    await env.ads.claim(ME, other, "wheel_spin", at(NOON, 1));

    await expect(env.service.claim(PLAYER, sessionId, at(NOON, 1))).rejects.toBeInstanceOf(AdDailyCapError);
    expect(env.claims.rows).toHaveLength(0);
    expect(env.wallet.grants).toHaveLength(0);
  });

  it("два запроса разом разными сессиями: взято один раз, второй получает «уже взято»", async () => {
    const env = setup({ blocks: [adBlock("adsgram", 10, { place: "free_gems" }), adBlock("richads", 20, { place: "free_gems" })] });
    const [first, second] = [await watched(env), await watched(env)];
    const results = await Promise.allSettled([env.service.claim(PLAYER, first, NOON), env.service.claim(PLAYER, second, NOON)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(FreeGemsClaimedError);
    expect(env.claims.rows).toHaveLength(1);
    expect(env.wallet.grants).toHaveLength(1);
  });

  it("два запроса разом одной сессией: одно начисление, оба получают ответ", async () => {
    const env = setup();
    const sessionId = await watched(env);
    const results = await Promise.all([env.service.claim(PLAYER, sessionId, NOON), env.service.claim(PLAYER, sessionId, NOON)]);
    expect(results[0]?.credited).toBe(5);
    expect(results[1]?.view).toEqual({ status: "claimed", gems: 5 });
    expect(env.claims.rows).toHaveLength(1);
    expect(env.wallet.grants).toHaveLength(1);
  });
});

describe("самоцветы за ролик по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;
  const shopView = { items: [], payable: true, mode: "test", recommended: null, tribute: null };

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(env: Setup): Promise<NestFastifyApplication> {
    @Module({
      controllers: [ShopController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ShopService, useValue: { view: async () => shopView } },
        { provide: ShowcaseService, useValue: {} },
        { provide: FreeGemsService, useValue: env.service },
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

  it("без токена — 401; кривое тело — 400; витрина с freeGems; взятие — 200 и «взято»; вторая сессия — 409 free_gems_claimed", async () => {
    const env = setup({ blocks: [adBlock("adsgram", 10, { place: "free_gems" }), adBlock("richads", 20, { place: "free_gems" })] });
    const server = await start(env);
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };
    const claim = (payload: unknown) => server.inject({ method: "POST", url: "/api/v1/shop/free-gems", headers, payload: payload as object });
    const session = () => watched(env, new Date());

    expect((await server.inject({ method: "GET", url: "/api/v1/shop" })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/api/v1/shop/free-gems", payload: { sessionId: "AAAAAAAAAAAAAAAA" } })).statusCode).toBe(401);
    for (const payload of [{}, { sessionId: "short" }, { sessionId: "AAAAAAAAAAAAAAAA", extra: 1 }, { sessionId: 7 }]) {
      expect((await claim(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }

    const before = await server.inject({ method: "GET", url: "/api/v1/shop", headers });
    expect(before.statusCode).toBe(200);
    expect(before.json<{ data: unknown }>().data).toMatchObject({ payable: true, freeGems: { status: "available", gems: 5, ad: { available: true, pass: null, capped: false } } });

    const first = await session();
    const result = await claim({ sessionId: first });
    expect(result.statusCode).toBe(200);
    expect(result.json<{ data: unknown }>().data).toEqual({ credited: 5, view: { status: "claimed", gems: 5 } });
    const after = await server.inject({ method: "GET", url: "/api/v1/shop", headers });
    expect(after.json<{ data: { freeGems: unknown } }>().data.freeGems).toEqual({ status: "claimed", gems: 5 });

    const second = await claim({ sessionId: await session() });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("free_gems_claimed");
    expect((await claim({ sessionId: first })).statusCode).toBe(200);
    expect(env.wallet.grants).toHaveLength(1);
  });
});
