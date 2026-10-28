import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { closeRedis, createRedis, REDIS } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { RunGemContinueController } from "../src/modules/runs/run-gem-continue.controller.js";
import { RunGemContinueService } from "../src/modules/runs/run-gem-continue.service.js";
import { PrismaRunAdContinuesRepository } from "../src/modules/runs/run-ad-continues.repository.js";
import { PrismaRunGemContinuesRepository } from "../src/modules/runs/run-gem-continues.repository.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { judgeRun } from "../src/modules/runs/run-verdict.js";
import { RUNS_LIMITS } from "../src/modules/runs/runs-limits.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Второй шанс за самоцветы на живом Postgres с настоящим кошельком и
 * Redis (docs/17-testing-strategy.md §4.2; адреса — TEST_DATABASE_URL и
 * PLAYTEST_TEST_REDIS_URL, без базы пропуск). Память этого не покажет:
 * списание и строка продолжения — одна транзакция, повтор и гонка не
 * списывают дважды, номер, взятый рекламой, база не отдаст за самоцветы, а
 * не хватившее не оставляет ни строки, ни проводки.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = process.env.PLAYTEST_TEST_REDIS_URL ?? "";
const RACE_TIMEOUT_MS = 30_000;

describe.skipIf(DATABASE_URL === "")("второй шанс за самоцветы на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let runs: PrismaRunsRepository;
  let gems: PrismaRunGemContinuesRepository;
  let ads: PrismaRunAdContinuesRepository;
  let continues: RunContinues;
  let service: RunGemContinueService;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(760_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Самоцвет", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function fund(accountId: string, amount: number): Promise<void> {
    await wallet.grant({ accountId, resource: "gems", amount, reason: "level_reward", idempotencyKey: `test:${randomUUID()}` });
  }

  /** Забег, начатый `agoSec` секунд назад по часам сервера. */
  async function run(accountId: string, agoSec = 130): Promise<string> {
    const runId = randomUUID();
    await runs.start({ runId, accountId, difficulty: "normal", startingWeaponId: "spark", contentHash: "abc", startedAt: new Date(Date.now() - agoSec * 1000) });
    return runId;
  }

  const gemsOf = async (accountId: string) => (await wallet.balances(accountId)).gems;
  const rowsOf = async (runId: string) => await prisma.$queryRaw<{ continue_no: number; price_gems: number; elapsed_sec: number }[]>`SELECT continue_no, price_gems, elapsed_sec FROM run_gem_continue WHERE run_id = ${runId}`;
  const spent = async (accountId: string) =>
    await prisma.walletEntry.findMany({ where: { accountId, reason: "continue" }, select: { amount: true, idempotencyKey: true, source: true, resource: true } });
  const buy = (accountId: string, runId: string, elapsedSec = 125) => service.buy(accountId, runId, { continueNo: 1, elapsedSec });

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 20);
    accounts = new PrismaAccountRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    runs = new PrismaRunsRepository(prisma);
    gems = new PrismaRunGemContinuesRepository(prisma);
    ads = new PrismaRunAdContinuesRepository(prisma);
    continues = new RunContinues();
    // Книга рекламных продолжений — по таблице, как её подключает сервис рекламы.
    continues.provide({ check: async (runId) => ({ paid: (await ads.numbers(runId)).length, underpaid: false }), granted: async (runId) => await ads.numbers(runId) });
    service = new RunGemContinueService(config, runs, gems, wallet, continues);
    service.onModuleInit();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("цена и баланс до нажатия; чужой и незнакомый забег — «не видел старта»", async () => {
    const id = await account();
    await fund(id, 50);
    const runId = await run(id);

    expect(await service.view(id, runId, 125)).toEqual({ status: "available", continueNo: 1, priceGems: 4, balance: 50 });
    const stranger = await account();
    expect(await service.view(stranger, runId, 125)).toEqual({ status: "unavailable", reason: "unverified" });
    expect(await service.view(id, randomUUID(), 125)).toEqual({ status: "unavailable", reason: "unverified" });
  });

  it("покупка: самоцветы списаны причиной continue, строка есть, книга знает номер", async () => {
    const id = await account();
    await fund(id, 50);
    const runId = await run(id);

    expect(await buy(id, runId)).toEqual({ continueNo: 1, priceGems: 4, balance: 46 });

    expect(await gemsOf(id)).toBe(46);
    expect(await rowsOf(runId)).toEqual([{ continue_no: 1, price_gems: 4, elapsed_sec: 125 }]);
    expect(await spent(id)).toEqual([{ amount: -4n, idempotencyKey: `continue:${runId}:1:gems`, source: `run:${runId}`, resource: "gems" }]);
    expect(await continues.taken(runId)).toEqual(new Set([1]));
    expect(await service.view(id, runId, 125)).toEqual({ status: "unavailable", reason: "used_up" });
  });

  it("повтор POST — тот же ответ без второго списания", async () => {
    const id = await account();
    await fund(id, 50);
    const runId = await run(id);
    const first = await buy(id, runId);

    expect(await buy(id, runId, 128)).toEqual(first);
    expect(await buy(id, runId, 128)).toEqual(first);

    expect(await gemsOf(id)).toBe(46);
    expect(await rowsOf(runId)).toHaveLength(1);
    expect(await spent(id)).toHaveLength(1);
  });

  it("два и десять POST разом — одно списание и одна строка", async () => {
    const id = await account();
    await fund(id, 50);
    const runId = await run(id);

    const results = await Promise.all(Array.from({ length: 10 }, () => buy(id, runId)));

    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
    expect(await gemsOf(id)).toBe(46);
    expect(await rowsOf(runId)).toHaveLength(1);
    expect(await spent(id)).toHaveLength(1);
  }, RACE_TIMEOUT_MS);

  it("номер уже взят рекламой — 409 continue_taken, баланс не тронут, строки за самоцветы нет", async () => {
    const id = await account();
    await fund(id, 50);
    const runId = await run(id);
    await ads.grant({ runId, continueNo: 1, accountId: id, sessionId: randomUUID().replace(/-/g, "").slice(0, 16), networkKey: "adsgram", grantedAt: new Date() }, 5);

    await expect(buy(id, runId)).rejects.toMatchObject({ code: "continue_taken", status: 409 });

    expect(await gemsOf(id)).toBe(50);
    expect(await rowsOf(runId)).toEqual([]);
    expect(await spent(id)).toEqual([]);
  });

  it("мало самоцветов — 409 insufficient_funds, ни строки, ни проводки: транзакция откатилась целиком", async () => {
    const id = await account();
    await fund(id, 3);
    const runId = await run(id);

    await expect(buy(id, runId)).rejects.toMatchObject({ code: "insufficient_funds", status: 409, resource: "gems", needed: 4, balance: 3 });

    expect(await gemsOf(id)).toBe(3);
    expect(await rowsOf(runId)).toEqual([]);
    expect(await spent(id)).toEqual([]);
    // Игрок пополнил — та же покупка проходит: отказ ничего за собой не оставил.
    await fund(id, 10);
    expect(await buy(id, runId)).toMatchObject({ priceGems: 4, balance: 9 });
  });

  it("секунд больше, чем прошло по часам сервера, — отказ, ничего не списано", async () => {
    const id = await account();
    await fund(id, 50);
    const runId = await run(id, 30);

    await expect(buy(id, runId, 600)).rejects.toMatchObject({ code: "elapsed_exceeds_clock" });

    expect(await gemsOf(id)).toBe(50);
    expect(await rowsOf(runId)).toEqual([]);
  });

  it("чужой забег не покупается, а закончен — «продолжать нечего»", async () => {
    const owner = await account();
    const stranger = await account();
    await fund(stranger, 50);
    const runId = await run(owner);

    await expect(buy(stranger, runId)).rejects.toMatchObject({ code: "run_unverified" });
    expect(await gemsOf(stranger)).toBe(50);

    await prisma.run.update({ where: { runId }, data: { status: "finished" } });
    await fund(owner, 50);
    await expect(buy(owner, runId)).rejects.toMatchObject({ code: "continue_unavailable" });
    expect(await gemsOf(owner)).toBe(50);
  });

  it("реклама и самоцветы разом на один номер — выигрывает один, у проигравшего нет следов", async () => {
    const id = await account();
    await fund(id, 50);
    const runId = await run(id);
    const session = randomUUID().replace(/-/g, "").slice(0, 16);

    const [bought, granted] = await Promise.all([
      gems.buy({ runId, continueNo: 1, accountId: id, elapsedSec: 125, priceGems: 4, at: new Date() }),
      ads.grant({ runId, continueNo: 1, accountId: id, sessionId: session, networkKey: "adsgram", grantedAt: new Date() }, 5),
    ]);

    const adRows = await ads.numbers(runId);
    const gemRows = await rowsOf(runId);
    expect(adRows.length + gemRows.length, "номер выдан ровно одним способом").toBe(1);
    if (bought.status === "bought") {
      expect(granted).toBe("taken");
      expect(await gemsOf(id)).toBe(46);
    } else {
      expect(bought.status).toBe("taken");
      expect(granted).toBe("granted");
      expect(await gemsOf(id)).toBe(50);
      expect(await spent(id)).toEqual([]);
    }
  }, RACE_TIMEOUT_MS);

  it("итог забега с продолжением за самоцветы — вердикт без unpaid_continue; на минуту позже оплаченной — underpaid_continue", async () => {
    const id = await account();
    await fund(id, 50);
    const runId = await run(id, 300);
    await buy(id, runId, 125);

    const verdictOf = async (sec: number, forRun = runId) => {
      const paid = await continues.check(forRun, [sec]);
      return judgeRun(
        {
          survivalSec: 250,
          level: 5,
          enemiesKilled: 100,
          weaponCount: 1,
          contentHash: "abc",
          startedAtMs: Date.now() - 300_000,
          finishedAtMs: Date.now(),
          continues: 1,
          paidContinues: paid.paid,
          underpaidContinues: paid.underpaid,
          cheats: false,
          loadout: "none",
          boosts: "none",
        },
        config.runs,
      );
    };

    expect((await verdictOf(125)).reasons).not.toContain("unpaid_continue");
    expect((await verdictOf(125)).reasons).not.toContain("underpaid_continue");
    // 125 с — третья минута; 185 с — четвёртая, цена выше уплаченной.
    expect(await verdictOf(185)).toMatchObject({ verdict: "suspicious", reasons: ["underpaid_continue"] });
    // Продолжение, за которое не заплачено ни одним способом, — отказ.
    expect(await verdictOf(100, await run(id, 300))).toMatchObject({ verdict: "rejected", reasons: ["unpaid_continue"] });
  });

  it("строка уходит каскадом вместе с забегом, а база не примет номер меньше единицы и нулевую цену", async () => {
    const id = await account();
    await fund(id, 50);
    const runId = await run(id);
    await buy(id, runId);

    await expect(prisma.$executeRaw`INSERT INTO run_gem_continue (run_id, continue_no, account_id, elapsed_sec, price_gems, granted_at) VALUES (${runId}, 0, ${id}::uuid, 10, 2, now())`).rejects.toThrow();
    await expect(prisma.$executeRaw`INSERT INTO run_gem_continue (run_id, continue_no, account_id, elapsed_sec, price_gems, granted_at) VALUES (${runId}, 2, ${id}::uuid, 10, 0, now())`).rejects.toThrow();

    await prisma.run.delete({ where: { runId } });
    expect(await rowsOf(runId)).toEqual([]);
  });
});

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("второй шанс за самоцветы по HTTP: Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let runs: PrismaRunsRepository;
  let app: NestFastifyApplication;
  let limiter: RateLimiter;

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 10);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    runs = new PrismaRunsRepository(prisma);
    limiter = new RateLimiter(redis);
    const continues = new RunContinues();
    const service = new RunGemContinueService(config, runs, new PrismaRunGemContinuesRepository(prisma), wallet, continues);
    service.onModuleInit();

    @Module({
      controllers: [RunGemContinueController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: redis },
        { provide: RunGemContinueService, useValue: service },
        { provide: RateLimiter, useValue: limiter },
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await closeRedis(redis);
    await prisma.$disconnect();
  });

  async function player(gemsAmount: number): Promise<{ accountId: string; runId: string; headers: { authorization: string } }> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(850_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Http", username: null },
      Date.now(),
    );
    await wallet.grant({ accountId: created.accountId, resource: "gems", amount: gemsAmount, reason: "level_reward", idempotencyKey: `test:${randomUUID()}` });
    const runId = randomUUID();
    await runs.start({ runId, accountId: created.accountId, difficulty: "normal", startingWeaponId: "spark", contentHash: "abc", startedAt: new Date(Date.now() - 130_000) });
    const token = await signAccessToken({ accountId: created.accountId, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    return { accountId: created.accountId, runId, headers: { authorization: `Bearer ${token}` } };
  }

  it("GET → POST → повтор: цена, покупка, тот же ответ; баланс списан один раз", async () => {
    const { runId, headers, accountId } = await player(50);
    const url = `/api/v1/runs/${runId}/continues/gems`;

    expect((await app.inject({ method: "GET", url: `${url}?elapsedSec=125`, headers })).json()).toEqual({ data: { status: "available", continueNo: 1, priceGems: 4, balance: 50 } });
    const bought = await app.inject({ method: "POST", url, headers, payload: { continueNo: 1, elapsedSec: 125 } });
    expect(bought.statusCode).toBe(200);
    expect(bought.json()).toEqual({ data: { continueNo: 1, priceGems: 4, balance: 46 } });
    expect((await app.inject({ method: "POST", url, headers, payload: { continueNo: 1, elapsedSec: 125 } })).json()).toEqual(bought.json());
    expect((await wallet.balances(accountId)).gems).toBe(46);
  }, RACE_TIMEOUT_MS);

  it("мало самоцветов — 409 insufficient_funds; лимит на аккаунт в Redis — 429", async () => {
    const { runId, headers, accountId } = await player(2);
    const url = `/api/v1/runs/${runId}/continues/gems`;

    const poor = await app.inject({ method: "POST", url, headers, payload: { continueNo: 1, elapsedSec: 125 } });
    expect(poor.statusCode).toBe(409);
    expect(poor.json()).toMatchObject({ error: { code: "insufficient_funds" } });

    await limiter.consume(RUNS_LIMITS.gemContinue, accountId, RUNS_LIMITS.gemContinue.limit);
    expect((await app.inject({ method: "GET", url: `${url}?elapsedSec=125`, headers })).statusCode).toBe(429);
  }, RACE_TIMEOUT_MS);
});
