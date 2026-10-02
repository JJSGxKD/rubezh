import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AdNotCompletedError } from "../src/modules/ads/ads-errors.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { RunAdContinueController } from "../src/modules/runs/run-ad-continue.controller.js";
import { AD_CONTINUES_PER_DAY, RunAdContinueService, type ContinuePlayer } from "../src/modules/runs/run-ad-continue.service.js";
import type { AdContinueGrant, GrantOutcome, RunAdContinuesRepository } from "../src/modules/runs/run-ad-continues.repository.js";
import { AdContinueDailyCapError, AdContinueUnavailableError, ContinueRunUnverifiedError, ContinueTakenError } from "../src/modules/runs/run-continue-errors.js";
import { RunContinues, type ContinueLedger } from "../src/modules/runs/run-continues.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeCreatives, MemoryAds, adBlock } from "./helpers/memory-ads.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Второй шанс за рекламу (docs/35-stage4-plan.md WP11, Р4): только своим
 * незаконченным забегом, только первое продолжение и не больше
 * `AD_CONTINUES_PER_DAY` в сутки; досмотренная сессия не тратится на забег,
 * который продолжить нельзя; номер, купленный за звёзды, за рекламу не
 * выдаётся; итог забега сверяется с обеими книгами.
 */

const ME = "00000000-0000-4000-8000-00000000c001";
const OTHER = "00000000-0000-4000-8000-00000000c002";
const PLAYER: ContinuePlayer = { accountId: ME, platform: "telegram" };
const MINUTE = 60_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);
const MOSCOW_MS = 3 * 60 * MINUTE;

class MemoryAdContinues implements RunAdContinuesRepository {
  readonly rows: AdContinueGrant[] = [];

  async grant(grant: AdContinueGrant): Promise<GrantOutcome> {
    const same = this.rows.find((row) => row.sessionId === grant.sessionId && row.runId === grant.runId && row.continueNo === grant.continueNo);
    if (same !== undefined) return "repeat";
    if (this.rows.some((row) => row.sessionId === grant.sessionId || (row.runId === grant.runId && row.continueNo === grant.continueNo))) return "taken";
    this.rows.push({ ...grant });
    return "granted";
  }

  async bySession(sessionId: string): Promise<{ runId: string; continueNo: number } | null> {
    const row = this.rows.find((candidate) => candidate.sessionId === sessionId);
    return row === undefined ? null : { runId: row.runId, continueNo: row.continueNo };
  }

  async numbers(runId: string): Promise<number[]> {
    return this.rows.filter((row) => row.runId === runId).map((row) => row.continueNo);
  }

  async todayCount(accountId: string, time: Date): Promise<number> {
    const dayStart = Math.floor((time.getTime() + MOSCOW_MS) / (24 * 60 * MINUTE)) * 24 * 60 * MINUTE - MOSCOW_MS;
    const day = 24 * 60 * MINUTE;
    return this.rows.filter((row) => row.accountId === accountId && row.grantedAt.getTime() >= dayStart && row.grantedAt.getTime() < dayStart + day).length;
  }
}

/** Книга покупок за звёзды — номера, оплаченные у забега. */
class StarsLedger implements ContinueLedger {
  readonly bought = new Map<string, number[]>();
  async check(runId: string): Promise<{ paid: number; underpaid: boolean }> {
    return { paid: (this.bought.get(runId) ?? []).length, underpaid: false };
  }
  async granted(runId: string): Promise<number[]> {
    return this.bought.get(runId) ?? [];
  }
}

const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

function setup(blocks = [adBlock("adsgram", 10, { place: "second_chance" }), adBlock("adsonar", 20, { place: "second_chance" })]) {
  const runs = new MemoryRunsRepository();
  const repository = new MemoryAdContinues();
  const adsRepository = new MemoryAds();
  adsRepository.blocks = blocks;
  const passes = new AdPasses();
  const ads = new AdsService(adsRepository, () => 0, passes, panelSettings(), new FakeCreatives(), new AdNetworkKeys(adsRepository));
  const continues = new RunContinues();
  const stars = new StarsLedger();
  continues.provide(stars);
  const service = new RunAdContinueService(config(), runs, repository, ads, continues);
  service.onModuleInit();
  return { runs, repository, adsRepository, ads, passes, continues, stars, service };
}

async function started(runs: MemoryRunsRepository, runId: string, accountId = ME): Promise<void> {
  await runs.start({ runId, accountId, difficulty: "normal", startingWeaponId: "spark", contentHash: "c0ffee", startedAt: NOON });
}

async function watched(ads: AdsService, time: Date): Promise<string> {
  const offer = await ads.offer({ ...PLAYER, device: "android" }, "second_chance", time);
  if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
  await ads.report(ME, offer.sessionId, { kind: "completed" }, time);
  return offer.sessionId;
}

describe("можно ли продолжить за рекламу", () => {
  it("незнакомый и чужой забег — одинаково «не видел старта»; записанный — «закончен»", async () => {
    const { service, runs } = setup();
    expect(await service.view(PLAYER, "nope", NOON)).toEqual({ status: "unavailable", reason: "unverified" });
    await started(runs, "foreign", OTHER);
    expect(await service.view(PLAYER, "foreign", NOON)).toEqual({ status: "unavailable", reason: "unverified" });
    await started(runs, "done");
    const row = runs.rows.get("done");
    if (row !== undefined) row.status = "finished";
    expect(await service.view(PLAYER, "done", NOON)).toEqual({ status: "unavailable", reason: "finished" });
  });

  it("свежий забег — первое продолжение; без блоков для площадки — «рекламы нет», а VIP — без ролика", async () => {
    const { service, runs, passes } = setup([adBlock("adsgram", 10, { place: "second_chance", platforms: ["telegram"] })]);
    await started(runs, "run-1");
    expect(await service.view(PLAYER, "run-1", at(3))).toEqual({ status: "available", continueNo: 1, pass: null });
    expect(await service.view({ accountId: ME, platform: "vk" }, "run-1", at(3))).toEqual({ status: "unavailable", reason: "no_ads" });
    passes.register("vip", async (accountId) => accountId === ME);
    expect(await service.view({ accountId: ME, platform: "vk" }, "run-1", at(3))).toEqual({ status: "available", continueNo: 1, pass: "vip" });
  });

  it("продолжение уже куплено за звёзды — за рекламу его нет", async () => {
    const { service, runs, stars } = setup();
    await started(runs, "run-1");
    stars.bought.set("run-1", [1]);
    expect(await service.view(PLAYER, "run-1", at(3))).toEqual({ status: "unavailable", reason: "used_up" });
  });
});

describe("продолжение за рекламу", () => {
  it("досмотренная сессия продолжает забег; итог сверяется с обеими книгами; повтор той же — то же продолжение", async () => {
    const { service, runs, ads, repository, continues } = setup();
    await started(runs, "run-1");
    const sessionId = await watched(ads, at(3));

    expect(await service.claim(PLAYER, "run-1", sessionId, at(3))).toEqual({ continueNo: 1 });
    expect(repository.rows[0]).toMatchObject({ runId: "run-1", continueNo: 1, sessionId, networkKey: "adsgram" });
    expect(await continues.check("run-1", [180])).toEqual({ paid: 1, underpaid: false });
    expect(await continues.taken("run-1")).toEqual(new Set([1]));
    // Ответ потерялся — клиент повторяет той же сессией и получает то же продолжение.
    expect(await service.claim(PLAYER, "run-1", sessionId, at(4))).toEqual({ continueNo: 1 });
    expect(repository.rows).toHaveLength(1);
    expect(await service.view(PLAYER, "run-1", at(4))).toEqual({ status: "unavailable", reason: "used_up" });
  });

  it("недосмотренная сессия — отказ, и продолжения нет", async () => {
    const { service, runs, ads } = setup();
    await started(runs, "run-1");
    const offer = await ads.offer({ ...PLAYER, device: "android" }, "second_chance", at(3));
    if (!offer.available) throw new Error("показа нет");
    await expect(service.claim(PLAYER, "run-1", offer.sessionId, at(3))).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(await service.view(PLAYER, "run-1", at(3))).toMatchObject({ status: "available" });
  });

  it("продолжить нельзя — досмотренная сессия не тратится: её ещё можно забрать", async () => {
    const { service, runs, ads, stars, adsRepository } = setup();
    await started(runs, "run-1");
    await started(runs, "foreign", OTHER);
    const sessionId = await watched(ads, at(3));

    await expect(service.claim(PLAYER, "nope", sessionId, at(3))).rejects.toBeInstanceOf(ContinueRunUnverifiedError);
    await expect(service.claim(PLAYER, "foreign", sessionId, at(3))).rejects.toBeInstanceOf(ContinueRunUnverifiedError);
    stars.bought.set("run-1", [1]);
    await expect(service.claim(PLAYER, "run-1", sessionId, at(3))).rejects.toBeInstanceOf(AdContinueUnavailableError);
    expect(adsRepository.sessions.find((session) => session.sessionId === sessionId)?.status).toBe("completed");
  });

  it("сессия, потраченная на другой забег, второй забег не продолжает", async () => {
    const { service, runs, ads } = setup();
    await started(runs, "run-1");
    await started(runs, "run-2");
    const sessionId = await watched(ads, at(3));
    await service.claim(PLAYER, "run-1", sessionId, at(3));
    await expect(service.claim(PLAYER, "run-2", sessionId, at(4))).rejects.toBeInstanceOf(ContinueTakenError);
  });

  it(`не больше ${String(AD_CONTINUES_PER_DAY)} в игровые сутки; в полночь по Москве — снова`, async () => {
    const { service, runs, ads } = setup();
    for (let index = 0; index < AD_CONTINUES_PER_DAY; index++) {
      await started(runs, `run-${String(index)}`);
      await service.claim(PLAYER, `run-${String(index)}`, await watched(ads, at(index * 10)), at(index * 10));
    }
    await started(runs, "late");
    expect(await service.view(PLAYER, "late", at(60))).toEqual({ status: "unavailable", reason: "daily_cap" });
    await expect(service.claim(PLAYER, "late", await watched(ads, at(60)), at(60))).rejects.toBeInstanceOf(AdContinueDailyCapError);
    // 12:00 по Москве + 12 ч = полночь: новые сутки.
    expect(await service.view(PLAYER, "late", at(12 * 60))).toMatchObject({ status: "available" });
  });

  it("VIP — пропуск вместо ролика забирается так же, как досмотр", async () => {
    const { service, runs, ads, passes, repository } = setup([]);
    passes.register("vip", async (accountId) => accountId === ME);
    await started(runs, "run-1");
    const offer = await ads.offer({ ...PLAYER, device: "android" }, "second_chance", at(3));
    if (!offer.available) throw new Error("пропуска нет");
    expect(offer.pass).toBe("vip");
    expect(await service.claim(PLAYER, "run-1", offer.sessionId, at(3))).toEqual({ continueNo: 1 });
    expect(repository.rows[0]?.networkKey).toBe("vip");
  });
});

describe("второй шанс за рекламу по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(service: RunAdContinueService): Promise<NestFastifyApplication> {
    @Module({
      controllers: [RunAdContinueController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: RunAdContinueService, useValue: service },
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

  it("без токена — 401; кривая сессия — 400; продолжение — 200, отказ — 409 с кодом", async () => {
    const { service, runs, ads } = setup();
    await started(runs, "run-http-1");
    const server = await start(service);
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };
    const url = "/api/v1/runs/run-http-1/continues/ad";

    expect((await server.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/v1/runs/short/continues/ad", headers })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url, headers })).json()).toEqual({ data: { status: "available", continueNo: 1, pass: null } });
    for (const payload of [{}, { sessionId: "short" }, { sessionId: "AAAAAAAAAAAAAAAA", extra: 1 }]) {
      expect((await server.inject({ method: "POST", url, headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }

    const sessionId = await watched(ads, new Date());
    const claimed = await server.inject({ method: "POST", url, headers, payload: { sessionId } });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toEqual({ data: { continueNo: 1 } });
    const other = await watched(ads, new Date());
    const refused = await server.inject({ method: "POST", url, headers, payload: { sessionId: other } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "continue_unavailable" } });
  });
});
