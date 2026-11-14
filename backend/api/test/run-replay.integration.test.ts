import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Logger } from "@nestjs/common";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { createQueueConnection } from "../src/infra/queues.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import type { EventRow } from "../src/modules/events/events.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { PrismaRunProofsRepository } from "../src/modules/runs/run-proofs.repository.js";
import { RunProofsService } from "../src/modules/runs/run-proofs.service.js";
import { REPLAY_KEEP_DAYS, jobIdOf, type ReplayFacts } from "../src/modules/runs/run-replay-rules.js";
import { PrismaRunReplayRepository } from "../src/modules/runs/run-replay.repository.js";
import { BullReplayQueue } from "../src/modules/runs/run-replay.job.js";
import { RunReplayService } from "../src/modules/runs/run-replay.service.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, ratingRestrictions } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";
import { testPrisma } from "./helpers/test-prisma.js";

/**
 * Перепроверка забегов на живых Postgres и Redis (tasks/T-0319,
 * docs/35-stage4-plan.md WP5): запись пришла — задание в очереди; исход воркера
 * читается и ложится в строку забега; расхождение уводит забег из рейтинга;
 * «Повторить снова» ставит новое задание и пишет строку аудита. Воркер
 * `sim-worker` подменён настоящим воркером BullMQ с ответом из теста: повтор
 * движка проверяет `apps/sim-worker/test/replay-job.test.ts`, а здесь — серверная
 * половина. Без базы и Redis файл пропускается.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = process.env.PLAYTEST_TEST_REDIS_URL ?? "";
const TIMEOUT_MS = 30_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const HASH = "abcd1234abcd1234";
const POINTS = 5_000;

const packed = (runId: string): string =>
  gzipSync(
    Buffer.from(
      JSON.stringify({
        schema: "run-proof-v1",
        runId,
        seed: 123456,
        mapId: "field",
        difficultyId: "hard",
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
      }),
    ),
  ).toString("base64");

const matchOf = (runId: string) => ({ runId, verdict: "match", reason: null, divergedTick: null, replayed: { ticks: 3600, survivalSec: 60, level: 3, enemiesKilled: 40, checksum: 99 }, durationMs: 700 });

describe.skipIf(DATABASE_URL === "" || REDIS_URL === "")("перепроверка забегов на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let runs: PrismaRunsRepository;
  let board: MemoryLeaderboardStore;
  let queue: BullReplayQueue;
  let worker: Worker;
  let service: RunReplayService;
  let proofs: RunProofsService;
  let roles: MemoryRolesRepository;
  let settings: ReturnType<typeof panelSettings>;
  const events: EventRow[] = [];
  const logs: string[] = [];
  /** что «sim-worker» ответит по забегу; нет записи — совпадение */
  const answers = new Map<string, unknown>();
  const facts: { value: ReplayFacts } = { value: { mode: "endless", cheats: false, verdict: "ok", ranked: true, boardPlace: 87, seasonPlace: null, seasonDivision: null, lootRarity: null, rubezhCleared: false } };
  const queueName = `replay-test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 8);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    board = new MemoryLeaderboardStore();
    roles = new MemoryRolesRepository();
    settings = panelSettings({ [SETTINGS.replaySampleRate.key]: 0 });
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logs.push(String(message)));
    vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => void logs.push(String(message)));

    queue = new BullReplayQueue(config, queueName);
    worker = new Worker(queueName, async (job: { data: { runId: string } }) => answers.get(job.data.runId) ?? matchOf(job.data.runId), { connection: createQueueConnection(config, "worker"), concurrency: 2 });

    const rolesService = new RolesService(config, roles, new MemoryAccountRepository());
    const restrictions = ratingRestrictions(runs, board);
    const runsService = new RunsService(config, runs, board, rolesService, new RunsHooks(), new RunContinues(), new RunLoadouts(), restrictions.rating);
    const proofsRepository = new PrismaRunProofsRepository(prisma);
    proofs = new RunProofsService(proofsRepository);
    service = new RunReplayService(
      new PrismaRunReplayRepository(prisma),
      proofsRepository,
      queue,
      runsService,
      { of: () => Promise.resolve(facts.value) },
      settings,
      rolesService,
      {
        write: (rows) => {
          events.push(...rows);
          return Promise.resolve();
        },
      },
    );
    // Подписка, которую в приложении делает `RunReplayJob`: запись пришла — повтор ставится.
    proofs.onStored("replay", (runId) => service.onProofStored(runId));
  });

  afterAll(async () => {
    await worker.close();
    await queue.onModuleDestroy();
    await closeRedis(redis);
    await prisma.$disconnect();
  });

  async function player(): Promise<AccountRef> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(870_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: "Повтор", username: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId: "1" };
  }

  /** Законченный рейтинговый забег в базе и очках доски. */
  async function finishedRun(account: AccountRef, patch: { finishedAt?: Date; verdict?: "ok" | "suspicious" } = {}): Promise<RecordedRun> {
    const runId = randomUUID();
    const finishedAt = patch.finishedAt ?? new Date();
    await runs.start({ runId, accountId: account.accountId, difficulty: "hard", startingWeaponId: "spark", contentHash: HASH, startedAt: new Date(finishedAt.getTime() - 120_000) });
    await runs.finish({
      runId,
      accountId: account.accountId,
      difficulty: "hard",
      startingWeaponId: "spark",
      contentHash: HASH,
      finishedAt,
      outcome: "died",
      survivalSec: 61.5,
      level: 3,
      enemiesKilled: 40,
      weapons: [{ id: "spark", level: 2 }],
      details: null,
      deathCause: "swarm_rat",
      cheats: false,
      continues: [],
      ranked: true,
      ratingRestricted: null,
      verdict: patch.verdict ?? "ok",
      verdictReasons: [],
      rubezhReached: false,
      rubezhClearedSec: null,
      score: { points: POINTS, axes: { t: 1, k: 1, h: 1, c: 1, b: 1 }, style: "t", band: "average" },
    });
    await board.submit("hard", account.accountId, POINTS, ["full", "common"]);
    return {
      runId,
      accountId: account.accountId,
      difficulty: "hard",
      mode: "endless",
      outcome: "died",
      survivalSec: 61.5,
      points: POINTS,
      level: 3,
      enemiesKilled: 40,
      startingWeaponId: "spark",
      weapons: [],
      boosts: [],
      xpCollected: null,
      counters: null,
      deathCause: null,
      cheats: false,
      continues: 0,
      ranked: true,
      verdict: "ok",
      reasons: [],
      finishedAt,
    };
  }

  const rowOf = async (runId: string) =>
    (
      await prisma.$queryRaw<
        { replay_verdict: string | null; replay_diverged_tick: number | null; replayed_at: Date | null; replay_required: boolean; replay_attempt: number; replay_queued_at: Date | null; verdict: string; verdict_reasons: string[]; ranked: boolean }[]
      >`SELECT replay_verdict, replay_diverged_tick, replayed_at, replay_required, replay_attempt, replay_queued_at, verdict, verdict_reasons, ranked FROM run WHERE run_id = ${runId}`
    )[0];

  const keepUntil = async (runId: string) => (await prisma.$queryRaw<{ keep_until: Date; received_at: Date }[]>`SELECT keep_until, received_at FROM run_proof WHERE run_id = ${runId}`)[0];

  /** Ждём, пока воркер сервера-двойника закончит задание. */
  async function untilFinished(runId: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await queue.finished(50)).some((job) => job.runId === runId)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("задание не закончилось");
  }

  /** Забег с обязательным повтором и принятой записью: задание уходит само, по приходу записи. */
  async function required(patch: { finishedAt?: Date } = {}): Promise<{ account: AccountRef; run: RecordedRun }> {
    const account = await player();
    const run = await finishedRun(account, patch);
    await service.onRecorded(run);
    await proofs.receive(account.accountId, run.runId, packed(run.runId));
    return { account, run };
  }

  it("запись пришла — задание поставлено: строка «ожидает», обязательность и отметка очереди; задание лежит в Redis", async () => {
    const account = await player();
    const run = await finishedRun(account);

    await service.onRecorded(run);
    expect(await rowOf(run.runId)).toMatchObject({ replay_verdict: "pending", replay_required: true, replay_queued_at: null });
    expect(await queue.has(jobIdOf(run.runId, 0))).toBe(false);

    await proofs.receive(account.accountId, run.runId, packed(run.runId));

    expect(await queue.has(jobIdOf(run.runId, 0))).toBe(true);
    expect((await rowOf(run.runId))?.replay_queued_at).not.toBeNull();
    await untilFinished(run.runId);
  }, TIMEOUT_MS);

  it("match — вердикт прежний, забег в рейтинге, запись хранится 180 дней, событие и строка метрики записаны", async () => {
    const { run } = await required();
    await untilFinished(run.runId);

    await service.sweep();

    expect(await rowOf(run.runId)).toMatchObject({ replay_verdict: "match", verdict: "ok", ranked: true });
    const proof = await keepUntil(run.runId);
    expect((proof?.keep_until.getTime() ?? 0) - Date.now()).toBeGreaterThan((REPLAY_KEEP_DAYS - 1) * DAY_MS);
    expect(events.some((event) => event.eventType === "run_replayed" && event.payload.runId === run.runId && event.payload.verdict === "match")).toBe(true);
    expect(logs.some((line) => line.includes("replay_outcome_total") && line.includes('"verdict":"match"'))).toBe(true);
    expect(await queue.has(jobIdOf(run.runId, 0))).toBe(false);
  }, TIMEOUT_MS);

  it("mismatch — подозрение с причиной replay_mismatch, тик расхождения записан, забег ушёл из рейтинга и из доски", async () => {
    const account = await player();
    const run = await finishedRun(account);
    answers.set(run.runId, { ...matchOf(run.runId), verdict: "mismatch", divergedTick: 1800, reason: "свёртка минуты разошлась" });
    await service.onRecorded(run);
    await proofs.receive(account.accountId, run.runId, packed(run.runId));
    await untilFinished(run.runId);

    await service.sweep();

    const row = await rowOf(run.runId);
    expect(row).toMatchObject({ replay_verdict: "mismatch", replay_diverged_tick: 1800, verdict: "suspicious", verdict_reasons: ["replay_mismatch"], ranked: false });
    expect(row?.replayed_at).not.toBeNull();
    expect(await board.best("hard", account.accountId, "common")).toBeNull();
    // Забег виден в очереди разбора, и исход читается пачкой.
    expect((await service.outcomes([run.runId])).get(run.runId)).toEqual({ verdict: "mismatch", divergedTick: 1800 });
    expect((await service.view(run.runId)).replayed).toMatchObject({ checksum: 99 });
  }, TIMEOUT_MS);

  it("ключ replay.mismatch-verdict = rejected — отказ", async () => {
    settings.set(SETTINGS.replayMismatchVerdict.key, "rejected");
    try {
      const account = await player();
      const run = await finishedRun(account);
      answers.set(run.runId, { ...matchOf(run.runId), verdict: "mismatch", divergedTick: 600 });
      await service.onRecorded(run);
      await proofs.receive(account.accountId, run.runId, packed(run.runId));
      await untilFinished(run.runId);

      await service.sweep();

      expect(await rowOf(run.runId)).toMatchObject({ replay_verdict: "mismatch", verdict: "rejected", ranked: false });
    } finally {
      settings.set(SETTINGS.replayMismatchVerdict.key, "suspicious");
    }
  }, TIMEOUT_MS);

  it("timeout — вердикт и рейтинг прежние: это наша сторона", async () => {
    const account = await player();
    const run = await finishedRun(account);
    answers.set(run.runId, { runId: run.runId, verdict: "timeout", reason: "повтор не уложился в 60 с", divergedTick: null, replayed: null, durationMs: 60_000 });
    await service.onRecorded(run);
    await proofs.receive(account.accountId, run.runId, packed(run.runId));
    await untilFinished(run.runId);

    await service.sweep();

    expect(await rowOf(run.runId)).toMatchObject({ replay_verdict: "timeout", verdict: "ok", ranked: true, verdict_reasons: [] });
    expect(await board.best("hard", account.accountId, "common")).toBe(POINTS);
  }, TIMEOUT_MS);

  it("записи нет 72 часа — no_proof, вердикт прежний; через 71 час — ещё ждём", async () => {
    const account = await player();
    const old = await finishedRun(account, { finishedAt: new Date(Date.now() - 73 * HOUR_MS) });
    const fresh = await finishedRun(account, { finishedAt: new Date(Date.now() - 71 * HOUR_MS) });
    await service.onRecorded(old);
    await service.onRecorded(fresh);

    await service.sweep();

    expect(await rowOf(old.runId)).toMatchObject({ replay_verdict: "no_proof", verdict: "ok", ranked: true });
    expect((await rowOf(fresh.runId))?.replay_verdict).toBe("pending");
    expect(events.some((event) => event.payload.runId === old.runId && event.payload.verdict === "no_proof")).toBe(true);
  }, TIMEOUT_MS);

  it("«Повторить снова» — новое задание под новой попыткой, строка аудита, прежний исход в `before`", async () => {
    const { account, run } = await required();
    await untilFinished(run.runId);
    await service.sweep();
    expect((await rowOf(run.runId))?.replay_verdict).toBe("match");
    const admin = await player();
    await roles.grant(admin.accountId, "moderator", null);

    const view = await service.repeat(admin, run.runId);

    expect(view.verdict).toBe("pending");
    expect(await rowOf(run.runId)).toMatchObject({ replay_verdict: "pending", replay_attempt: 1, replay_diverged_tick: null });
    expect(await queue.has(jobIdOf(run.runId, 1))).toBe(true);
    const entry = roles.entries.find((candidate) => candidate.action === "players.run.replay");
    expect(entry).toMatchObject({ actorAccountId: admin.accountId, target: account.accountId, before: { replayVerdict: "match", divergedTick: null }, after: { runId: run.runId } });

    await untilFinished(run.runId);
    await service.sweep();
    expect((await rowOf(run.runId))?.replay_verdict).toBe("match");

    // Второе нажатие, пока исход не снят, — отказ: задание не множится.
    const second = await service.repeat(admin, run.runId);
    expect(second.verdict).toBe("pending");
    await expect(service.repeat(admin, run.runId)).rejects.toMatchObject({ status: 409 });
  }, TIMEOUT_MS);

  it("потерянное задание (очередь очищена) ставится заново через полчаса", async () => {
    const account = await player();
    const run = await finishedRun(account);
    await service.onRecorded(run);
    await proofs.receive(account.accountId, run.runId, packed(run.runId));
    await untilFinished(run.runId);
    await queue.remove(jobIdOf(run.runId, 0));
    await prisma.$executeRaw`UPDATE run SET replay_queued_at = now() - interval '40 minutes' WHERE run_id = ${run.runId}`;

    await service.sweep();

    expect(await queue.has(jobIdOf(run.runId, 0))).toBe(true);
    await untilFinished(run.runId);
    await service.sweep();
    expect((await rowOf(run.runId))?.replay_verdict).toBe("match");
  }, TIMEOUT_MS);
});
