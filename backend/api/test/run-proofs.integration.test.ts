import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { closeRedis, createRedis, REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { RunsController } from "../src/modules/runs/runs.controller.js";
import { RUN_PROOF_LIMITS, RUNS_LIMITS } from "../src/modules/runs/runs-limits.js";
import { PrismaRunProofsRepository } from "../src/modules/runs/run-proofs.repository.js";
import { RunProofsService } from "../src/modules/runs/run-proofs.service.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Приём записи забега для проверки на живых Postgres и Redis (tasks/T-0317,
 * docs/35-stage4-plan.md WP5): только к своему забегу, форма, размер до и
 * после распаковки, хэш контента, дубль и конфликт, срок хранения, очистка и
 * лимит запросов. Без базы и Redis — пропуск.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = process.env.PLAYTEST_TEST_REDIS_URL ?? "";
const TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
const HASH = "abcd1234abcd1234";

/** Запись по форме `RunProof`: ровно то, что пришлёт клиент (T-0316). */
function proofOf(runId: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "run-proof-v1",
    runId,
    seed: 123456,
    mapId: "field",
    difficultyId: "normal",
    mode: "endless",
    startingWeaponId: "spark",
    contentHash: HASH,
    unitScale: 1,
    loadout: { modifiers: { damage: 0.1 }, boosts: [], accountLevel: 5 },
    input: { encoding: "rle-v1", ticks: 3600, data: "AAEC", truncated: false },
    choices: [[600, "might"]],
    continues: [],
    checkpoints: [[3600, 12345]],
    result: { ticks: 3600, survivalSec: 60, level: 3, enemiesKilled: 40, deathCause: "swarm_rat", checksum: 99 },
    ...patch,
  };
}

const packed = (value: unknown): string => gzipSync(Buffer.from(JSON.stringify(value))).toString("base64");

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("запись забега для проверки на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let app: NestFastifyApplication;
  let service: RunProofsService;
  let limiter: RateLimiter;
  let accounts: PrismaAccountRepository;
  let runs: PrismaRunsRepository;
  const logs: string[] = [];

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 8);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    limiter = new RateLimiter(redis);
    service = new RunProofsService(new PrismaRunProofsRepository(prisma));
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)));

    @Module({
      controllers: [RunsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: redis },
        { provide: RunProofsService, useValue: service },
        // Остальные зависимости контроллера этим маршрутам не нужны.
        { provide: RunsService, useValue: {} },
        { provide: RunsViewService, useValue: {} },
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

  async function player(): Promise<{ accountId: string; headers: { authorization: string } }> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(880_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Запись", username: null }, Date.now());
    const token = await signAccessToken({ accountId: created.accountId, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    return { accountId: created.accountId, headers: { authorization: `Bearer ${token}` } };
  }

  async function run(accountId: string, contentHash = HASH): Promise<string> {
    const runId = randomUUID();
    await runs.start({ runId, accountId, difficulty: "normal", startingWeaponId: "spark", contentHash, startedAt: new Date(Date.now() - 120_000) });
    return runId;
  }

  const put = (runId: string, headers: { authorization: string }, proof: string) => app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/proof`, headers, payload: { proof } });
  const rows = (runId: string) => prisma.$queryRaw<{ size_bytes: number; received_at: Date; keep_until: Date }[]>`SELECT size_bytes, received_at, keep_until FROM run_proof WHERE run_id = ${runId}`;

  it("своя запись — 200: строка есть, keep_until через 7 дней, размер — сжатые байты", async () => {
    const { accountId, headers } = await player();
    const runId = await run(accountId);
    const body = packed(proofOf(runId));

    const response = await put(runId, headers, body);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { status: "stored" } });
    const [row] = await rows(runId);
    expect(row?.size_bytes).toBe(Buffer.from(body, "base64").length);
    expect((row?.keep_until.getTime() ?? 0) - (row?.received_at.getTime() ?? 0)).toBe(7 * DAY_MS);
    // Исход приёма — в лог строкой с видом исхода: счётчик по нему считает сборщик журналов.
    expect(logs.some((line) => line.includes("run_proof_received") && line.includes('"outcome":"stored"'))).toBe(true);
  }, TIMEOUT_MS);

  it("чужой и несуществующий забег — 404, ничего не записано", async () => {
    const owner = await player();
    const stranger = await player();
    const runId = await run(owner.accountId);

    const foreign = await put(runId, stranger.headers, packed(proofOf(runId)));
    expect(foreign.statusCode).toBe(404);
    const ghost = randomUUID();
    expect((await put(ghost, stranger.headers, packed(proofOf(ghost)))).statusCode).toBe(404);
    expect(await rows(runId)).toEqual([]);
  }, TIMEOUT_MS);

  it("70 КБ — 422 до распаковки; распакованная 600 КБ — 422", async () => {
    const { accountId, headers } = await player();
    const runId = await run(accountId);

    const tooBig = await put(runId, headers, Buffer.alloc(70 * 1024, 7).toString("base64"));
    expect(tooBig.statusCode).toBe(422);
    expect(tooBig.json()).toMatchObject({ error: { code: "run_proof_invalid" } });

    // Сжимается в крошки, а распакованная — 600 КБ: бомба.
    const bomb = packed(proofOf(runId, { mapId: "x".repeat(600 * 1024) }));
    expect(Buffer.from(bomb, "base64").length).toBeLessThan(RUN_PROOF_LIMITS.maxPackedBytes);
    expect((await put(runId, headers, bomb)).statusCode).toBe(422);
    expect(await rows(runId)).toEqual([]);
  }, TIMEOUT_MS);

  it("не gzip и не JSON, форма не по схеме, лог ввода не влез — 422 с причиной", async () => {
    const { accountId, headers } = await player();
    const runId = await run(accountId);

    for (const body of [Buffer.from("не gzip").toString("base64"), gzipSync(Buffer.from("не json")).toString("base64"), packed({ schema: "run-proof-v1" }), packed(proofOf(runId, { schema: "run-proof-v9" })), packed(proofOf(runId, { input: { encoding: "rle-v1", ticks: 1, data: "AA", truncated: true } }))]) {
      const response = await put(runId, headers, body);
      expect(response.statusCode, body.slice(0, 20)).toBe(422);
      expect(response.json<{ error: { message: string } }>().error.message).not.toBe("");
    }
    expect(await rows(runId)).toEqual([]);
  }, TIMEOUT_MS);

  it("runId внутри записи другой — 422; хэш контента не тот — 422", async () => {
    const { accountId, headers } = await player();
    const runId = await run(accountId);

    expect((await put(runId, headers, packed(proofOf(randomUUID())))).statusCode).toBe(422);
    expect((await put(runId, headers, packed(proofOf(runId, { contentHash: "0000000000000000" })))).statusCode).toBe(422);
    expect(await rows(runId)).toEqual([]);
  }, TIMEOUT_MS);

  it("повтор той же записи — 200 без перезаписи; другая к тому же забегу — 409", async () => {
    const { accountId, headers } = await player();
    const runId = await run(accountId);
    const original = proofOf(runId);
    await put(runId, headers, packed(original));
    const [before] = await rows(runId);

    // Те же данные другим сжатием — та же запись.
    const again = await put(runId, headers, gzipSync(Buffer.from(JSON.stringify(original)), { level: 1 }).toString("base64"));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ data: { status: "duplicate" } });
    expect(await rows(runId)).toEqual([before]);

    const other = await put(runId, headers, packed(proofOf(runId, { seed: 999 })));
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: { code: "run_proof_conflict" } });
    expect(await rows(runId)).toEqual([before]);
  }, TIMEOUT_MS);

  it("две одинаковые записи разом — одна строка, обе отвечают 200", async () => {
    const { accountId, headers } = await player();
    const runId = await run(accountId);
    const body = packed(proofOf(runId));

    const responses = await Promise.all([put(runId, headers, body), put(runId, headers, body), put(runId, headers, body)]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(await rows(runId)).toHaveLength(1);
  }, TIMEOUT_MS);

  it("очистка удаляет просроченные пачками и не трогает 180-дневные", async () => {
    const { accountId } = await player();
    const now = new Date();
    const make = async (keepDays: number) => {
      const runId = await run(accountId);
      await prisma.$executeRaw`
        INSERT INTO run_proof (run_id, proof, size_bytes, received_at, keep_until)
        VALUES (${runId}, ${Buffer.from("x")}, 1, ${new Date(now.getTime() - 10 * DAY_MS)}, ${new Date(now.getTime() + keepDays * DAY_MS)})`;
      return runId;
    };
    const expired = [await make(-3), await make(-1), await make(-1)];
    const week = await make(2);
    const verified = await make(170);

    // Пачка по одной: удаляет всё просроченное несколькими проходами и сообщает, сколько.
    const removed = await service.cleanup(now, 1);

    expect(removed).toBeGreaterThanOrEqual(3);
    for (const runId of expired) expect(await rows(runId)).toEqual([]);
    expect(await rows(week)).toHaveLength(1);
    expect(await rows(verified)).toHaveLength(1);
  }, TIMEOUT_MS);

  it("запись уходит вместе с забегом (каскад)", async () => {
    const { accountId, headers } = await player();
    const runId = await run(accountId);
    await put(runId, headers, packed(proofOf(runId)));

    await prisma.run.delete({ where: { runId } });

    expect(await rows(runId)).toEqual([]);
  }, TIMEOUT_MS);

  it("31-й запрос в минуту — 429", async () => {
    const { accountId, headers } = await player();
    const runId = await run(accountId);
    expect(RUNS_LIMITS.proof).toEqual({ scope: "runs:proof", limit: 30, windowSec: 60 });

    await limiter.consume(RUNS_LIMITS.proof, accountId, RUNS_LIMITS.proof.limit);
    const response = await put(runId, headers, packed(proofOf(runId)));

    expect(response.statusCode).toBe(429);
    expect(await rows(runId)).toEqual([]);
  }, TIMEOUT_MS);

  it("без сессии — 401; тело не по форме — 400", async () => {
    const { accountId, headers } = await player();
    const runId = await run(accountId);

    expect((await app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/proof`, payload: { proof: "AA==" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/proof`, headers, payload: { proof: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/proof`, headers, payload: {} })).statusCode).toBe(400);
  }, TIMEOUT_MS);
});
