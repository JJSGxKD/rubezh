import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { PLACE_FORMAT, PLACE_TITLES } from "../src/modules/ads/ad-networks.js";
import { AD_PLACES, CAPPED_PLACES, PLACE_RULES } from "../src/modules/ads/ads-rules.js";
import { AdNotCompletedError } from "../src/modules/ads/ads-errors.js";
import { AdPasses } from "../src/modules/ads/ads-passes.js";
import { AdNetworkKeys } from "../src/modules/ads/ad-network-keys.js";
import { AdsService } from "../src/modules/ads/ads.service.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { ContinueRunUnverifiedError } from "../src/modules/runs/run-continue-errors.js";
import { RunAdChestController } from "../src/modules/runs/run-ad-chest.controller.js";
import { RunAdChestService, type AdChestPlayer } from "../src/modules/runs/run-ad-chest.service.js";
import type { AdChestGrant, ChestGrantOutcome, RunAdChestsRepository } from "../src/modules/runs/run-ad-chests.repository.js";
import { AdChestTakenError, AdChestUnavailableError } from "../src/modules/runs/run-chest-errors.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { runFinishSchema, type RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { RUNS_LIMITS } from "../src/modules/runs/runs-limits.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeCreatives, MemoryAds, adBlock, interstitialGate } from "./helpers/memory-ads.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions, survivalScorer } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Второй сундук клада за рекламу (tasks/T-0327, Р162): забег — хозяин места
 * `clad_chest`. Один на забег: и в таблице (`run_id` — ключ), и здесь;
 * досмотренная сессия не тратится на забег, где сундук уже взят или которого
 * нет; итог забега сверяется с книгой через `paid`. Был ли в забеге клад,
 * сервер не знает — за показ он ручается, а клад проверит повтор забега.
 */

const ME = "00000000-0000-4000-8000-00000000d001";
const OTHER = "00000000-0000-4000-8000-00000000d002";
const PLAYER: AdChestPlayer = { accountId: ME, platform: "telegram" };
const MINUTE = 60_000;
const NOON = new Date(Date.UTC(2026, 10, 13, 9));
const at = (minutes: number) => new Date(NOON.getTime() + minutes * MINUTE);

/** Книга вторых сундуков в памяти: те же ключи, что у базы, — забег и сессия уникальны. */
class MemoryAdChests implements RunAdChestsRepository {
  readonly rows: AdChestGrant[] = [];

  async grant(grant: AdChestGrant): Promise<ChestGrantOutcome> {
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

function setup(blocks = [adBlock("adsgram", 10, { place: "clad_chest" }), adBlock("richads", 20, { place: "clad_chest" }), adBlock("adsgram", 10, { place: "wheel_spin" })], settings = panelSettings()) {
  const runs = new MemoryRunsRepository();
  const repository = new MemoryAdChests();
  const adsRepository = new MemoryAds();
  adsRepository.blocks = blocks;
  const passes = new AdPasses();
  const restrictionRows = new MemoryRestrictionsRepository();
  const ads = new AdsService(adsRepository, () => 0, passes, settings, new FakeCreatives(), new AdNetworkKeys(adsRepository), interstitialGate(adsRepository, settings), restrictionsGate(restrictionRows));
  const service = new RunAdChestService(runs, repository, ads);
  return { runs, repository, adsRepository, ads, passes, restrictions: restrictionRows, service };
}

async function started(runs: MemoryRunsRepository, runId: string, accountId = ME): Promise<void> {
  await runs.start({ runId, accountId, difficulty: "hard", startingWeaponId: "spark", contentHash: "c0ffee", startedAt: NOON });
}

async function watched(ads: AdsService, time: Date, place: "clad_chest" | "wheel_spin" = "clad_chest", accountId = ME): Promise<string> {
  const offer = await ads.offer({ accountId, platform: "telegram", device: "android" }, place, time);
  if (!offer.available) throw new Error(`показа нет: ${offer.reason}`);
  await ads.report(accountId, offer.sessionId, { kind: "completed" }, time);
  return offer.sessionId;
}

describe("место показа clad_chest", () => {
  it("есть среди мест, с наградой и пропуском VIP, без кулдауна: ограничение «раз за забег» держит хозяин места", () => {
    expect(AD_PLACES).toContain("clad_chest");
    expect(AD_PLACES.indexOf("clad_chest")).toBe(AD_PLACES.indexOf("card_reroll") + 1);
    expect(PLACE_RULES.clad_chest).toEqual({ rewarded: true, pass: true, cooldown: null });
    expect(PLACE_FORMAT.clad_chest).toBe("rewarded");
    expect(PLACE_TITLES.clad_chest).toBe("Второй сундук клада");
  });

  it("входит в общий дневной кап роликов, как любое место с наградой", () => {
    expect(CAPPED_PLACES).toContain("clad_chest");
  });

  it("лимит частоты — отдельный ключ runs:chest-ad, 120 в час", () => {
    expect(RUNS_LIMITS.adChest).toEqual({ scope: "runs:chest-ad", limit: 120, windowSec: 3600 });
  });
});

describe("можно ли взять второй сундук за рекламу", () => {
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
    const { service, runs, passes } = setup([adBlock("adsgram", 10, { place: "clad_chest", platforms: ["telegram"] })]);
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

  it("общий дневной кап роликов исчерпан — «daily_cap», а не «рекламы нет»; VIP кап не касается", async () => {
    const settings = panelSettings({ "ads.rewarded.daily-cap": 1 });
    const { service, runs, ads, passes } = setup(undefined, settings);
    await started(runs, "run-1");
    // Один ролик в другом месте с наградой уже досмотрен — кап в один ролик достигнут.
    const wheel = await ads.offer({ ...PLAYER, device: "android" }, "wheel_spin", at(1));
    if (!wheel.available) throw new Error("показа нет");
    await ads.report(ME, wheel.sessionId, { kind: "completed" }, at(1));
    expect(await service.view(PLAYER, "run-1", at(3))).toEqual({ status: "unavailable", reason: "daily_cap" });
    passes.register("vip", async (accountId) => accountId === ME);
    expect(await service.view(PLAYER, "run-1", at(3))).toEqual({ status: "available", pass: "vip" });
  });

  it("после выданного сундука — «уже использован»", async () => {
    const { service, runs, ads } = setup();
    await started(runs, "run-1");
    await service.claim(PLAYER, "run-1", await watched(ads, at(3)), at(3));
    expect(await service.view(PLAYER, "run-1", at(4))).toEqual({ status: "unavailable", reason: "used_up" });
  });
});

describe("второй сундук за рекламу", () => {
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
    await expect(service.claim(PLAYER, "run-2", sessionId, at(4))).rejects.toBeInstanceOf(AdChestTakenError);
  });

  it("вторая сессия на тот же забег — «уже использован», и она не потрачена: её ещё можно забрать на другом забеге", async () => {
    const { service, runs, ads, repository, adsRepository } = setup();
    await started(runs, "run-1");
    await started(runs, "run-2");
    await service.claim(PLAYER, "run-1", await watched(ads, at(3)), at(3));
    const second = await watched(ads, at(5));

    await expect(service.claim(PLAYER, "run-1", second, at(6))).rejects.toBeInstanceOf(AdChestUnavailableError);
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
    await expect(service.claim(PLAYER, "done", sessionId, at(3))).rejects.toBeInstanceOf(AdChestUnavailableError);
    expect(adsRepository.sessions.find((session) => session.sessionId === sessionId)?.claimedAt).toBeNull();
  });

  it("недосмотренная сессия — отказ, записи нет", async () => {
    const { service, runs, ads, repository } = setup();
    await started(runs, "run-1");
    const offer = await ads.offer({ ...PLAYER, device: "android" }, "clad_chest", at(3));
    if (!offer.available) throw new Error("показа нет");
    await expect(service.claim(PLAYER, "run-1", offer.sessionId, at(3))).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(repository.rows).toEqual([]);
    expect(await service.view(PLAYER, "run-1", at(3))).toMatchObject({ status: "available" });
  });

  it("сессия другого места и чужого игрока — отказ, записи нет", async () => {
    const { service, runs, ads, repository } = setup([adBlock("adsgram", 10, { place: "clad_chest" }), adBlock("adsgram", 10, { place: "wheel_spin" })]);
    await started(runs, "run-1");
    const wheel = await watched(ads, at(3), "wheel_spin");
    await expect(service.claim(PLAYER, "run-1", wheel, at(3))).rejects.toBeInstanceOf(AdNotCompletedError);

    const foreign = await watched(ads, at(4), "clad_chest", OTHER);
    await expect(service.claim(PLAYER, "run-1", foreign, at(4))).rejects.toBeInstanceOf(AdNotCompletedError);
    expect(repository.rows).toEqual([]);
  });

  it("VIP — пропуск вместо ролика забирается так же, как досмотр", async () => {
    const { service, runs, ads, passes, repository } = setup([]);
    passes.register("vip", async (accountId) => accountId === ME);
    await started(runs, "run-1");
    const offer = await ads.offer({ ...PLAYER, device: "android" }, "clad_chest", at(3));
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
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(AdChestUnavailableError);
    expect(repository.rows).toHaveLength(1);
  });
});

describe("кап роликов при заборе", () => {
  it("сверх дневного капа забор — «ad_daily_cap», сессия не потрачена и в книгу ничего не записано", async () => {
    const settings = panelSettings({ "ads.rewarded.daily-cap": 1 });
    const { service, runs, ads, repository, adsRepository } = setup(undefined, settings);
    await started(runs, "run-1");
    // Обе сессии выданы, пока кап свободен, и досмотрены; колесо забрано первым и заняло кап.
    const chest = await ads.offer({ ...PLAYER, device: "android" }, "clad_chest", at(3));
    const wheel = await ads.offer({ ...PLAYER, device: "android" }, "wheel_spin", at(3));
    if (!chest.available || !wheel.available) throw new Error("показа нет");
    await ads.report(ME, chest.sessionId, { kind: "completed" }, at(4));
    await ads.report(ME, wheel.sessionId, { kind: "completed" }, at(4));
    await ads.claim(ME, wheel.sessionId, "wheel_spin", at(5));

    await expect(service.claim(PLAYER, "run-1", chest.sessionId, at(6))).rejects.toMatchObject({ code: "ad_daily_cap", status: 409 });
    expect(repository.rows).toEqual([]);
    expect(adsRepository.sessions.find((session) => session.sessionId === chest.sessionId)?.claimedAt).toBeNull();
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

describe("второй сундук за рекламу по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;
  const overLimitRedis = { eval: async () => RUNS_LIMITS.adChest.limit + 1 } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function start(service: RunAdChestService, redis: Redis = unavailableRedis): Promise<NestFastifyApplication> {
    @Module({
      controllers: [RunAdChestController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: REDIS, useValue: redis },
        { provide: RunAdChestService, useValue: service },
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
    const url = "/api/v1/runs/run-http-1/chests/ad";

    expect((await server.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url, payload: { sessionId: "AAAAAAAAAAAAAAAA" } })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/v1/runs/short/chests/ad", headers })).statusCode).toBe(400);
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

  it("отказы — 409 с кодами chest_unavailable, chest_taken и run_unverified", async () => {
    const { service, runs, ads } = setup();
    await started(runs, "run-http-1");
    await started(runs, "run-http-2");
    const server = await start(service);
    const headers = { authorization: `Bearer ${await token()}` };
    const url = (runId: string) => `/api/v1/runs/${runId}/chests/ad`;

    const first = await watched(ads, new Date());
    expect((await server.inject({ method: "POST", url: url("run-http-1"), headers, payload: { sessionId: first } })).statusCode).toBe(200);

    const second = await watched(ads, new Date());
    const unavailable = await server.inject({ method: "POST", url: url("run-http-1"), headers, payload: { sessionId: second } });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({ error: { code: "chest_unavailable" } });

    const taken = await server.inject({ method: "POST", url: url("run-http-2"), headers, payload: { sessionId: first } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: { code: "chest_taken" } });

    const unknown = await server.inject({ method: "POST", url: url("run-http-404"), headers, payload: { sessionId: second } });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ error: { code: "run_unverified" } });
  });

  it("сверх лимита частоты — 429, и вопрос, и забор", async () => {
    const { service, runs } = setup();
    await started(runs, "run-http-1");
    const server = await start(service, overLimitRedis);
    const headers = { authorization: `Bearer ${await token()}` };
    const url = "/api/v1/runs/run-http-1/chests/ad";

    expect((await server.inject({ method: "GET", url, headers })).statusCode).toBe(429);
    expect((await server.inject({ method: "POST", url, headers, payload: { sessionId: "AAAAAAAAAAAAAAAA" } })).statusCode).toBe(429);
  });
});

describe("второй сундук в итоге забега (tasks/T-0327)", () => {
  /** Книга показов: у каких забегов записан второй сундук; спросили ли её — видно по `asked`. */
  class BookedChests implements RunAdChestsRepository {
    readonly booked = new Set<string>();
    readonly asked: string[] = [];
    async grant(): Promise<"granted"> {
      throw new Error("приём итога ничего не записывает в книгу показов");
    }
    async bySession(): Promise<null> {
      throw new Error("приём итога не ищет сессию");
    }
    async count(runId: string): Promise<number> {
      this.asked.push(runId);
      return this.booked.has(runId) ? 1 : 0;
    }
  }

  function finishSetup() {
    const runs = new MemoryRunsRepository();
    const board = new MemoryLeaderboardStore();
    const hooks = new RunsHooks();
    const recorded: RecordedRun[] = [];
    hooks.onRecorded("test", async (run) => void recorded.push(run));
    const book = new BookedChests();
    const chests = new RunAdChestService(runs, book, {} as AdsService);
    const roles = new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository());
    const service = new RunsService(config(), runs, board, roles, hooks, new RunContinues(), new RunLoadouts(), ratingRestrictions(runs, board).rating, undefined, survivalScorer(), undefined, chests);
    return { service, book, recorded, runs, board };
  }

  const me = (): AccountRef => ({ accountId: randomUUID(), platform: "telegram", platformUserId: "555" });

  function finish(runId: string, patch: Partial<RunFinish> = {}): RunFinish {
    return {
      runId,
      difficultyId: "hard",
      outcome: "died",
      survivalSec: 600,
      level: 6,
      enemiesKilled: 300,
      startingWeaponId: "knife",
      weapons: [{ id: "knife", level: 2 }],
      contentHash: "abc",
      deathCause: "swarm_rat",
      cheats: false,
      countInRating: false,
      continues: [],
      boosts: [],
      passives: [],
      adChests: 0,
      ...patch,
    };
  }

  it("заявлен второй сундук без записи показа — отказ с нейтральной причиной, мимо рейтинга, но забег записан", async () => {
    const { service, recorded, board } = finishSetup();
    const account = me();

    const result = await service.finish(account, finish(randomUUID(), { adChests: 1 }));

    expect(result).toMatchObject({ verdict: "rejected", recorded: false });
    expect(recorded[0]).toMatchObject({ reasons: expect.arrayContaining(["unpaid_ad_chest"]) });
    expect(await board.best("hard", account.accountId, "common")).toBeNull();
  });

  it("с записью показа — обычный забег в рейтинге", async () => {
    const { service, book, runs } = finishSetup();
    const runId = randomUUID();
    book.booked.add(runId);

    await expect(service.finish(me(), finish(runId, { adChests: 1 }))).resolves.toMatchObject({ verdict: "ok", recorded: true });
    expect(runs.rows.get(runId)?.record).toBeDefined();
    expect(book.asked).toEqual([runId]);
  });

  it("запись показа другого забега не засчитывается этому", async () => {
    const { service, book, recorded } = finishSetup();
    book.booked.add(randomUUID());

    await service.finish(me(), finish(randomUUID(), { adChests: 1 }));

    expect(recorded[0]?.reasons ?? []).toContain("unpaid_ad_chest");
  });

  it("итог с нулём — в книгу показов не ходят", async () => {
    const { service, book } = finishSetup();

    await expect(service.finish(me(), finish(randomUUID(), { adChests: 0 }))).resolves.toMatchObject({ verdict: "ok", recorded: true });
    expect(book.asked).toEqual([]);
  });

  it("забег с читами разработчика причиной не отклоняется, как у продолжений", async () => {
    const { service, recorded } = finishSetup();

    await service.finish(me(), finish(randomUUID(), { adChests: 1, cheats: true }));

    expect(recorded[0]?.reasons ?? []).not.toContain("unpaid_ad_chest");
  });

  it("число вторых сундуков вне 0..1 — битые данные, а не вердикт; нет поля — ноль", () => {
    const base: Record<string, unknown> = { ...finish(randomUUID(), { survivalSec: 300 }) };
    delete base.adChests;

    expect(runFinishSchema.safeParse({ ...base, adChests: 0 }).success).toBe(true);
    expect(runFinishSchema.safeParse({ ...base, adChests: 1 }).success).toBe(true);
    for (const adChests of [2, -1, 1.5, "1", null]) expect(runFinishSchema.safeParse({ ...base, adChests }).success, String(adChests)).toBe(false);
    expect(runFinishSchema.parse(base).adChests).toBe(0);
  });
});
