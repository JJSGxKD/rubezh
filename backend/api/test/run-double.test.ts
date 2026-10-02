import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AdCooldownError, AdNotCompletedError } from "../src/modules/ads/ads-errors.js";
import { maxRewardsPerDay } from "../src/modules/ads/ads-rules.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import { panelSettings } from "./helpers/settings.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { MAX_COINS_PER_RUN } from "../src/modules/progress/progress-rules.js";
import { RunAlreadyDoubledError, RunDoubleUnavailableError } from "../src/modules/progress/run-double-errors.js";
import { RunDoubleController } from "../src/modules/progress/run-double.controller.js";
import type { DoubleCandidate, RunDoubleRepository } from "../src/modules/progress/run-double.repository.js";
import { RUN_DOUBLE_WINDOW_MIN, RunDoubleService, type RunDoublePlayer } from "../src/modules/progress/run-double.service.js";
import { WALLET_DAILY_CAPS } from "../src/modules/wallet/wallet-limits.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeCreatives, MemoryAds, adBlock } from "./helpers/memory-ads.js";

/**
 * Удвоение награды за забег за рекламу (docs/35-stage4-plan.md WP4, WP12):
 * только монеты, что легли, одним досмотренным показом и один раз на забег,
 * в окне после забега и в кулдаун места; досмотренная сессия не тратится на
 * забег, который удвоить нельзя.
 */

const ME = "00000000-0000-4000-8000-00000000d001";
const PLAYER: RunDoublePlayer = { accountId: ME, platform: "telegram" };
const MINUTE = 60_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);

class MemoryRunDouble implements RunDoubleRepository {
  readonly rows = new Map<string, DoubleCandidate & { accountId: string }>();

  add(runId: string, patch: Partial<DoubleCandidate> = {}): void {
    this.rows.set(runId, { runId, accountId: ME, coinsCredited: 90, skipped: null, createdAt: NOON, doubleSessionId: null, doubledAt: null, ...patch });
  }

  async candidate(runId: string, accountId: string): Promise<DoubleCandidate | null> {
    const row = this.rows.get(runId);
    return row === undefined || row.accountId !== accountId ? null : { ...row };
  }

  async attach(runId: string, accountId: string, sessionId: string): Promise<boolean> {
    const row = this.rows.get(runId);
    if (row === undefined || row.accountId !== accountId || (row.doubleSessionId !== null && row.doubleSessionId !== sessionId)) return false;
    row.doubleSessionId = sessionId;
    return true;
  }

  async markDoubled(runId: string, time: Date): Promise<void> {
    const row = this.rows.get(runId);
    if (row !== undefined) row.doubledAt ??= time;
  }
}

class FakeWallet {
  readonly grants: GrantInput[] = [];
  readonly keys = new Set<string>();
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
    return { credited: input.amount, balance: 0, duplicate };
  }
}

function setup(blocks = [adBlock("adsgram", 10, { place: "run_double" }), adBlock("adsonar", 20, { place: "run_double" })]) {
  const repository = new MemoryRunDouble();
  const adsRepository = new MemoryAds();
  adsRepository.blocks = blocks;
  const passes = new AdPasses();
  const ads = new AdsService(adsRepository, () => 0, passes, panelSettings(), new FakeCreatives(), new AdNetworkKeys(adsRepository));
  const wallet = new FakeWallet();
  const service = new RunDoubleService(repository, ads, wallet as unknown as WalletService);
  return { repository, adsRepository, ads, wallet, service, passes };
}

async function watched(ads: AdsService, time: Date): Promise<string> {
  const offer = await ads.offer({ ...PLAYER, device: "android" }, "run_double", time);
  if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
  await ads.report(ME, offer.sessionId, { kind: "completed" }, time);
  return offer.sessionId;
}

describe("можно ли удвоить", () => {
  it("награда считается, без награды, ничего не легло, окно прошло — нельзя, с причиной", async () => {
    const { service, repository } = setup();
    expect(await service.view(PLAYER, "nope", NOON)).toEqual({ status: "unavailable", reason: "pending" });
    repository.add("counting", { coinsCredited: null });
    repository.add("cheats", { coinsCredited: null, skipped: "cheats" });
    repository.add("capped", { coinsCredited: 0 });
    repository.add("old", { createdAt: at(-RUN_DOUBLE_WINDOW_MIN - 1) });
    expect(await service.view(PLAYER, "counting", NOON)).toEqual({ status: "unavailable", reason: "pending" });
    expect(await service.view(PLAYER, "cheats", NOON)).toEqual({ status: "unavailable", reason: "no_reward" });
    expect(await service.view(PLAYER, "capped", NOON)).toEqual({ status: "unavailable", reason: "nothing" });
    expect(await service.view(PLAYER, "old", NOON)).toEqual({ status: "unavailable", reason: "expired" });
  });

  it("свежий забег — можно: сколько монет, до когда, есть ли реклама для площадки", async () => {
    const { service, repository } = setup([adBlock("adsgram", 10, { place: "run_double", platforms: ["telegram"] })]);
    repository.add("run-1");
    expect(await service.view(PLAYER, "run-1", at(5))).toEqual({
      status: "available",
      coins: 90,
      until: at(RUN_DOUBLE_WINDOW_MIN).toISOString(),
      ad: { available: true, readyAt: null, pass: null },
    });
    expect(await service.view({ accountId: ME, platform: "vk" }, "run-1", at(5))).toMatchObject({ status: "available", ad: { available: false } });
  });
});

describe("удвоение", () => {
  it("монеты, что легли, — ещё раз, рекламной наградой с ключом забега; после — «удвоено»", async () => {
    const { service, repository, ads, wallet } = setup();
    repository.add("run-1");
    const sessionId = await watched(ads, at(2));
    expect(await service.double(PLAYER, "run-1", sessionId, at(2))).toEqual({ credited: 90, coins: 90 });
    expect(wallet.grants).toEqual([{ accountId: ME, resource: "coins", amount: 90, reason: "ad_reward", source: "run:run-1", idempotencyKey: "run_double:run-1", at: at(2) }]);
    expect(await service.view(PLAYER, "run-1", at(3))).toEqual({ status: "doubled", coins: 90 });
  });

  it("VIP удваивает без ролика: экран знает, что ролик не нужен, награда — та же рекламная", async () => {
    const { service, repository, ads, passes, wallet } = setup([]);
    passes.register("vip", async () => true);
    repository.add("run-1");
    expect(await service.view(PLAYER, "run-1", at(2))).toMatchObject({ status: "available", ad: { available: true, pass: "vip" } });
    const offer = await ads.offer({ ...PLAYER, device: null }, "run_double", at(2));
    if (!offer.available) throw new Error("показа нет");
    expect(await service.double(PLAYER, "run-1", offer.sessionId, at(2))).toEqual({ credited: 90, coins: 90 });
    expect(wallet.grants).toEqual([expect.objectContaining({ reason: "ad_reward", idempotencyKey: "run_double:run-1" })]);
  });

  it("недосмотренная сессия — отказ рекламы; забег, который удвоить нельзя, сессию не тратит", async () => {
    const { service, repository, ads, adsRepository } = setup();
    repository.add("run-1");
    repository.add("old", { createdAt: at(-RUN_DOUBLE_WINDOW_MIN - 1) });
    const offer = await ads.offer({ ...PLAYER, device: "android" }, "run_double", NOON);
    if (!offer.available) throw new Error("показа нет");
    await expect(service.double(PLAYER, "run-1", offer.sessionId, NOON)).rejects.toBeInstanceOf(AdNotCompletedError);

    const sessionId = await watched(ads, NOON);
    await expect(service.double(PLAYER, "old", sessionId, NOON)).rejects.toMatchObject({ code: "run_double_unavailable", reason: "expired" });
    expect(adsRepository.sessions.find((session) => session.sessionId === sessionId)?.status).toBe("completed");
    await expect(service.double(PLAYER, "run-1", sessionId, NOON)).resolves.toMatchObject({ credited: 90 });
  });

  it("обрыв начисления: повтор той же сессией дожимает — и после окна; другой сессией — уже удвоено", async () => {
    const { service, repository, ads, wallet } = setup();
    repository.add("run-1", { createdAt: at(-RUN_DOUBLE_WINDOW_MIN + 1) });
    const sessionId = await watched(ads, NOON);
    wallet.failNext = true;
    await expect(service.double(PLAYER, "run-1", sessionId, NOON)).rejects.toThrow(/кошелёк недоступен/);

    await expect(service.double(PLAYER, "run-1", sessionId, at(5))).resolves.toMatchObject({ credited: 90 });
    expect(wallet.grants).toHaveLength(1);
    await expect(service.double(PLAYER, "run-1", "BBBBBBBBBBBBBBBB", at(10))).rejects.toBeInstanceOf(RunAlreadyDoubledError);
  });

  it("два забега подряд: второе удвоение — после кулдауна места", async () => {
    const { service, repository, ads } = setup();
    repository.add("run-1");
    repository.add("run-2", { createdAt: at(1) });
    const first = await watched(ads, at(1));
    const second = await watched(ads, at(1));
    await service.double(PLAYER, "run-1", first, at(1));
    await expect(service.double(PLAYER, "run-2", second, at(2))).rejects.toBeInstanceOf(AdCooldownError);
    expect(await service.view(PLAYER, "run-2", at(2))).toMatchObject({ status: "available", ad: { readyAt: at(6).toISOString() } });
  });

  it("чужой забег удвоить нельзя: для другого аккаунта его нет", async () => {
    const { service, repository, ads } = setup();
    repository.add("run-1");
    const sessionId = await watched(ads, NOON);
    await expect(service.double({ accountId: "00000000-0000-4000-8000-00000000d002", platform: "telegram" }, "run-1", sessionId, NOON)).rejects.toBeInstanceOf(RunDoubleUnavailableError);
  });

  it("суточный потолок рекламы держит удвоения активного игрока с запасом, а упирается в него только забег за забегом на потолке монет", () => {
    const cap = WALLET_DAILY_CAPS.ad_reward.coins ?? 0;
    // Активный игрок — полтора десятка медианных забегов по 88 монет.
    expect(15 * 88 * 5).toBeLessThanOrEqual(cap);
    expect(WALLET_DAILY_CAPS.ad_reward.gems).toBeUndefined();
    expect((maxRewardsPerDay("run_double") ?? 0) * MAX_COINS_PER_RUN).toBeGreaterThan(cap);
  });
});

describe("удвоение по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("без токена — 401; кривой забег или тело — 400; удваивать нечего — 409 с кодом; удвоение — 200", async () => {
    const ctx = setup();
    ctx.repository.add("run-1", { createdAt: new Date() });
    ctx.repository.add("capped", { coinsCredited: 0, createdAt: new Date() });
    @Module({
      controllers: [RunDoubleController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: RunDoubleService, useValue: ctx.service },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/api/v1/progress/runs/run-1/double" })).statusCode).toBe(401);
    const view = await app.inject({ method: "GET", url: "/api/v1/progress/runs/run-1/double", headers });
    expect(view.json<{ data: { status: string } }>().data.status).toBe("available");

    for (const payload of [{}, { sessionId: "short" }, { sessionId: "AAAAAAAAAAAAAAAA", coins: 1000 }]) {
      expect((await app.inject({ method: "POST", url: "/api/v1/progress/runs/run-1/double", headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: `/api/v1/progress/runs/${"x".repeat(65)}/double`, headers, payload: { sessionId: "AAAAAAAAAAAAAAAA" } })).statusCode).toBe(400);

    const capped = await app.inject({ method: "POST", url: "/api/v1/progress/runs/capped/double", headers, payload: { sessionId: "AAAAAAAAAAAAAAAA" } });
    expect(capped.statusCode).toBe(409);
    expect(capped.json<{ error: { code: string } }>().error.code).toBe("run_double_unavailable");

    const sessionId = await watched(ctx.ads, new Date());
    const doubled = await app.inject({ method: "POST", url: "/api/v1/progress/runs/run-1/double", headers, payload: { sessionId } });
    expect(doubled.statusCode).toBe(200);
    expect(doubled.json<{ data: { credited: number } }>().data.credited).toBe(90);
  });
});
