import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { AD_PLACES, PLACE_RULES } from "../src/modules/ads/ads-rules.js";
import { AdNotCompletedError } from "../src/modules/ads/ads-errors.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { ContinueRunUnverifiedError } from "../src/modules/runs/run-continue-errors.js";
import { RunAdRerollController } from "../src/modules/runs/run-ad-reroll.controller.js";
import { RunAdRerollService, type AdRerollPlayer } from "../src/modules/runs/run-ad-reroll.service.js";
import type { AdRerollGrant, RerollGrantOutcome, RunAdRerollsRepository } from "../src/modules/runs/run-ad-rerolls.repository.js";
import { AdRerollTakenError, AdRerollUnavailableError } from "../src/modules/runs/run-reroll-errors.js";
import { RUNS_LIMITS } from "../src/modules/runs/runs-limits.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeCreatives, MemoryAds, adBlock, interstitialGate } from "./helpers/memory-ads.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Переброс карточек за рекламу (tasks/T-0199, Р133): забег — хозяин места
 * `card_reroll`. Один на забег: и в таблице (`run_id` — ключ), и здесь;
 * досмотренная сессия не тратится на забег, где переброс уже взят или которого
 * нет; итог забега сверяется с книгой через `paid`.
 */

const ME = "00000000-0000-4000-8000-00000000d001";
const OTHER = "00000000-0000-4000-8000-00000000d002";
const PLAYER: AdRerollPlayer = { accountId: ME, platform: "telegram" };
const MINUTE = 60_000;
const NOON = new Date(Date.UTC(2026, 10, 13, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);

/** Книга рекламных перебросов в памяти: те же ключи, что у базы, — забег и сессия уникальны. */
class MemoryAdRerolls implements RunAdRerollsRepository {
  readonly rows: AdRerollGrant[] = [];

  async grant(grant: AdRerollGrant): Promise<RerollGrantOutcome> {
    if (this.rows.some((row) => row.runId === grant.runId && row.sessionId === grant.sessionId)) return "repeat";
    if (this.rows.some((row) => row.runId === grant.runId || row.sessionId === grant.sessionId)) return "taken";
    this.rows.push({ ...grant });
    return "granted";
  }

  async bySession(sessionId: string): Promise<{ runId: string } | null> {
    const row = this.rows.find((candidate) => candidate.sessionId === sessionId);
    return row === undefined ? null : { runId: row.runId };
  }

  async count(runId: string): Promise<number> {
    return this.rows.filter((row) => row.runId === runId).length;
  }
}

const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

function setup(blocks = [adBlock("adsgram", 10, { place: "card_reroll" }), adBlock("richads", 20, { place: "card_reroll" })]) {
  const runs = new MemoryRunsRepository();
  const repository = new MemoryAdRerolls();
  const adsRepository = new MemoryAds();
  adsRepository.blocks = blocks;
  const passes = new AdPasses();
  const restrictionRows = new MemoryRestrictionsRepository();
  const ads = new AdsService(adsRepository, () => 0, passes, panelSettings(), new FakeCreatives(), new AdNetworkKeys(adsRepository), interstitialGate(adsRepository, panelSettings()), restrictionsGate(restrictionRows));
  const service = new RunAdRerollService(runs, repository, ads);
  return { runs, repository, adsRepository, ads, passes, restrictions: restrictionRows, service };
}

async function started(runs: MemoryRunsRepository, runId: string, accountId = ME): Promise<void> {
  await runs.start({ runId, accountId, difficulty: "hard", startingWeaponId: "spark", contentHash: "c0ffee", startedAt: NOON });
}

async function watched(ads: AdsService, time: Date, place: "card_reroll" | "wheel_spin" = "card_reroll", accountId = ME): Promise<string> {
  const offer = await ads.offer({ accountId, platform: "telegram", device: "android" }, place, time);
  if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
  await ads.report(accountId, offer.sessionId, { kind: "completed" }, time);
  return offer.sessionId;
}

describe("место показа card_reroll", () => {
  it("есть среди мест, с наградой и пропуском VIP, без кулдауна: ограничение «раз за забег» держит хозяин места", () => {
    expect(AD_PLACES).toContain("card_reroll");
    expect(AD_PLACES.indexOf("card_reroll")).toBe(AD_PLACES.indexOf("run_double") + 1);
    expect(PLACE_RULES.card_reroll).toEqual({ rewarded: true, pass: true, cooldown: null });
  });

  it("лимит частоты — отдельный ключ runs:reroll-ad, 120 в час", () => {
    expect(RUNS_LIMITS.adReroll).toEqual({ scope: "runs:reroll-ad", limit: 120, windowSec: 3600 });
  });
});

describe("можно ли перебросить за рекламу", () => {
  it("незнакомый и чужой забег — одинаково «не видел старта»; записанный как законченный — «закончен»", async () => {
    const { service, runs } = setup();
    expect(await service.view(PLAYER, "nope", NOON)).toEqual({ status: "unavailable", reason: "unverified" });
    await started(runs, "foreign", OTHER);
    expect(await service.view(PLAYER, "foreign", NOON)).toEqual({ status: "unavailable", reason: "unverified" });
    await started(runs, "done");
    const row = runs.rows.get("done");
    if (row !== undefined) row.status = "finished";
    expect(await service.view(PLAYER, "done", NOON)).toEqual({ status: "unavailable", reason: "finished" });
  });

  it("свежий забег с блоком места — доступно; без блоков для места или площадки — «рекламы нет», а VIP — без ролика", async () => {
    const { service, runs, passes } = setup([adBlock("adsgram", 10, { place: "card_reroll", platforms: ["telegram"] })]);
    await started(runs, "run-1");
    expect(await service.view(PLAYER, "run-1", at(3))).toEqual({ status: "available", pass: null });
    expect(await service.view({ accountId: ME, platform: "vk" }, "run-1", at(3))).toEqual({ status: "unavailable", reason: "no_ads" });
    passes.register("vip", async (accountId) => accountId === ME);
    expect(await service.view({ accountId: ME, platform: "vk" }, "run-1", at(3))).toEqual({ status: "available", pass: "vip" });
  });

  it("блоков для места нет вовсе — «рекламы нет»: пока блоки не заведены, кнопки у игроков нет", async () => {
    const { service, runs } = setup([adBlock("adsgram", 10, { place: "second_chance" })]);
    await started(runs, "run-1");
    expect(await service.view(PLAYER, "run-1", at(3))).toEqual({ status: "unavailable", reason: "no_ads" });
  });

  it("ограничение наград за рекламу без уведомления — «рекламы нет»", async () => {
    const { service, runs, restrictions } = setup();
    await started(runs, "run-1");
    restrictions.restrict(ME, "ad_rewards", { notify: false });
    expect(await service.view(PLAYER, "run-1", at(3))).toEqual({ status: "unavailable", reason: "no_ads" });
  });

  it("после выданного переброса — «уже использован»", async () => {
    const { service, runs, ads } = setup();
    await started(runs, "run-1");
    await service.claim(PLAYER, "run-1", await watched(ads, at(3)), at(3));
    expect(await service.view(PLAYER, "run-1", at(4))).toEqual({ status: "unavailable", reason: "used_up" });
  });
});

describe("переброс за рекламу", () => {
  it("досмотренная сессия записывает показ; повтор той же сессии на тот же забег — тот же ответ, строка одна", async () => {
    const { service, runs, ads, repository } = setup();
    await started(runs, "run-1");
    const sessionId = await watched(ads, at(3));

    expect(await service.claim(PLAYER, "run-1", sessionId, at(3))).toEqual({ granted: true });
    expect(repository.rows[0]).toMatchObject({ runId: "run-1", accountId: ME, sessionId, networkKey: "adsgram" });
    // Ответ потерялся — клиент повторяет той же сессией и получает то же.
    expect(await service.claim(PLAYER, "run-1", sessionId, at(4))).toEqual({ granted: true });
    expect(repository.rows).toHaveLength(1);
  });

  it("та же сессия на другой забег — «сессия потрачена»", async () => {
    const { service, runs, ads } = setup();
    await started(runs, "run-1");
    await started(runs, "run-2");
    const sessionId = await watched(ads, at(3));
    await service.claim(PLAYER, "run-1", sessionId, at(3));
    await expect(service.claim(PLAYER, "run-2", sessionId, at(4))).rejects.toBeInstanceOf(AdRerollTakenError);
  });

  it("вторая сессия на тот же забег — «уже использован», и она не потрачена: её ещё можно забрать на другом забеге", async () => {
    const { service, runs, ads, repository, adsRepository } = setup();
    await started(runs, "run-1");
    await started(runs, "run-2");
    await service.claim(PLAYER, "run-1", await watched(ads, at(3)), at(3));
    const second = await watched(ads, at(5));

    await expect(service.claim(PLAYER, "run-1", second, at(6))).rejects.toBeInstanceOf(AdRerollUnavailableError);
    expect(repository.rows).toHaveLength(1);
    expect(adsRepository.sessions.find((session) => session.sessionId === second)?.claimedAt).toBeNull();
    expect(await service.claim(PLAYER, "run-2", second, at(7))).toEqual({ granted: true });
    expect(repository.rows).toHaveLength(2);
  });

  it("незнакомый и чужой забег — одинаково «не видел старта»; законченный — «недоступно»; сессия при этом не тратится", async () => {
    const { service, runs, ads, adsRepository } = setup();
    await started(runs, "foreign", OTHER);
    await started(runs, "done");
    const row = runs.rows.get("done");
    if (row !== undefined) row.status = "finished";
    const sessionId = await watched(ads, at(3));

    await expect(service.claim(PLAYER, "nope", sessionId, at(3))).rejects.toBeInstanceOf(ContinueRunUnverifiedError);
    await expect(service.claim(PLAYER, "foreign", sessionId, at(3))).rejects.toBeInstanceOf(ContinueRunUnverifiedError);
    await expect(service.claim(PLAYER, "done", sessionId, at(3))).rejects.toBeInstanceOf(AdRerollUnavailableError);
    expect(adsRepository.sessions.find((session) => session.sessionId === sessionId)?.claimedAt).toBeNull();
  });

  it("недосмотренная сессия — отказ, записи нет", async () => {
    const { service, runs, ads, repository } = setup();
    await started(runs, "run-1");
    const offer = await ads.offer({ ...PLAYER, device: "android" }, "card_reroll", at(3));
    if (!offer.available) throw new Error("показа нет");
    await expect(service.claim(PLAYER, "run-1", offer.sessionId, at(3))).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(repository.rows).toEqual([]);
    expect(await service.view(PLAYER, "run-1", at(3))).toMatchObject({ status: "available" });
  });

  it("сессия другого места и чужого игрока — отказ, записи нет", async () => {
    const { service, runs, ads, repository } = setup([adBlock("adsgram", 10, { place: "card_reroll" }), adBlock("adsgram", 10, { place: "wheel_spin" })]);
    await started(runs, "run-1");
    const wheel = await watched(ads, at(3), "wheel_spin");
    await expect(service.claim(PLAYER, "run-1", wheel, at(3))).rejects.toBeInstanceOf(AdNotCompletedError);

    const foreign = await watched(ads, at(4), "card_reroll", OTHER);
    await expect(service.claim(PLAYER, "run-1", foreign, at(4))).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(repository.rows).toEqual([]);
  });

  it("VIP — пропуск вместо ролика забирается так же, как досмотр", async () => {
    const { service, runs, ads, passes, repository } = setup([]);
    passes.register("vip", async (accountId) => accountId === ME);
    await started(runs, "run-1");
    const offer = await ads.offer({ ...PLAYER, device: "android" }, "card_reroll", at(3));
    if (!offer.available) throw new Error("пропуска нет");
    expect(offer.pass).toBe("vip");
    expect(await service.claim(PLAYER, "run-1", offer.sessionId, at(3))).toEqual({ granted: true });
    expect(repository.rows[0]?.networkKey).toBe("vip");
  });

  it("параллельный забор: база пускает один, второй получает «уже использован»", async () => {
    const { service, runs, ads, repository } = setup();
    await started(runs, "run-1");
    const first = await watched(ads, at(3));
    const second = await watched(ads, at(3));
    // Проверка «уже есть» у обоих видит пустую книгу, а в базе к записи занято.
    const real = repository.count.bind(repository);
    repository.count = async () => 0;
    const results = await Promise.allSettled([service.claim(PLAYER, "run-1", first, at(3)), service.claim(PLAYER, "run-1", second, at(3))]);
    repository.count = real;

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(AdRerollUnavailableError);
    expect(repository.rows).toHaveLength(1);
  });
});

describe("книга для сверки итога", () => {
  it("paid(runId, 1) после claim — 1; без claim — 0; при нуле заявленных в книгу не ходят", async () => {
    const { service, runs, ads, repository } = setup();
    await started(runs, "run-1");
    await started(runs, "run-2");
    expect(await service.paid("run-1", 1)).toBe(0);
    await service.claim(PLAYER, "run-1", await watched(ads, at(3)), at(3));
    expect(await service.paid("run-1", 1)).toBe(1);
    expect(await service.paid("run-2", 1)).toBe(0);

    let asked = 0;
    const real = repository.count.bind(repository);
    repository.count = async (runId) => {
      asked++;
      return await real(runId);
    };
    expect(await service.paid("run-1", 0)).toBe(0);
    expect(asked).toBe(0);
  });
});

describe("переброс за рекламу по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;
  const overLimitRedis = { eval: async () => RUNS_LIMITS.adReroll.limit + 1 } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(service: RunAdRerollService, redis: Redis = unavailableRedis): Promise<NestFastifyApplication> {
    @Module({
      controllers: [RunAdRerollController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: redis },
        { provide: RunAdRerollService, useValue: service },
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

  const token = () => signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());

  it("без токена — 401; кривая сессия и забег — 400; успех — 200 { granted: true }", async () => {
    const { service, runs, ads } = setup();
    await started(runs, "run-http-1");
    const server = await start(service);
    const headers = { authorization: `Bearer ${await token()}` };
    const url = "/api/v1/runs/run-http-1/rerolls/ad";

    expect((await server.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url, payload: { sessionId: "AAAAAAAAAAAAAAAA" } })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/v1/runs/short/rerolls/ad", headers })).statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url, headers })).json()).toEqual({ data: { status: "available", pass: null } });
    for (const payload of [{}, { sessionId: "short" }, { sessionId: "AAAAAAAAAAAAAAAA", extra: 1 }]) {
      expect((await server.inject({ method: "POST", url, headers, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }

    const sessionId = await watched(ads, new Date());
    const claimed = await server.inject({ method: "POST", url, headers, payload: { sessionId } });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toEqual({ data: { granted: true } });
    expect((await server.inject({ method: "GET", url, headers })).json()).toEqual({ data: { status: "unavailable", reason: "used_up" } });
  });

  it("отказы — 409 с кодами reroll_unavailable, reroll_taken и run_unverified", async () => {
    const { service, runs, ads } = setup();
    await started(runs, "run-http-1");
    await started(runs, "run-http-2");
    const server = await start(service);
    const headers = { authorization: `Bearer ${await token()}` };
    const url = (runId: string) => `/api/v1/runs/${runId}/rerolls/ad`;

    const first = await watched(ads, new Date());
    expect((await server.inject({ method: "POST", url: url("run-http-1"), headers, payload: { sessionId: first } })).statusCode).toBe(200);

    const second = await watched(ads, new Date());
    const unavailable = await server.inject({ method: "POST", url: url("run-http-1"), headers, payload: { sessionId: second } });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({ error: { code: "reroll_unavailable" } });

    const taken = await server.inject({ method: "POST", url: url("run-http-2"), headers, payload: { sessionId: first } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: { code: "reroll_taken" } });

    const unknown = await server.inject({ method: "POST", url: url("run-http-404"), headers, payload: { sessionId: second } });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ error: { code: "run_unverified" } });
  });

  it("сверх лимита частоты — 429, и вопрос, и забор", async () => {
    const { service, runs } = setup();
    await started(runs, "run-http-1");
    const server = await start(service, overLimitRedis);
    const headers = { authorization: `Bearer ${await token()}` };
    const url = "/api/v1/runs/run-http-1/rerolls/ad";

    expect((await server.inject({ method: "GET", url, headers })).statusCode).toBe(429);
    expect((await server.inject({ method: "POST", url, headers, payload: { sessionId: "AAAAAAAAAAAAAAAA" } })).statusCode).toBe(429);
  });
});
