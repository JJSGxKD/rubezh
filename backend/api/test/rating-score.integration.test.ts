import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { bundledExpectedTable, expectedRowOf, type ExpectedTable } from "../src/modules/rating/expected-table.js";
import { PrismaRunScoresRepository } from "../src/modules/rating/run-scores.repository.js";
import { RunScorer } from "../src/modules/rating/run-scorer.service.js";
import { rescoreRuns } from "../src/modules/rating/runs-rescore.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { runFinishSchema, type RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { PrismaRunsRepository } from "../src/modules/runs/runs.repository.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, ratingRestrictions } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Очки эффективности на настоящем Postgres (tasks/T-0293). Адрес — TEST_DATABASE_URL;
 * без него файл пропускается. Память не покажет, что колонки очков и исходных
 * чисел действительно ложатся в строку забега и что пересчёт идёт по ним, а не
 * по клиентскому телу.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const live = DATABASE_URL !== "";

describe.skipIf(!live)("очки эффективности на живом Postgres", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let table: ExpectedTable;

  async function account(): Promise<AccountRef> {
    const platformUserId = String(900_000_000 + Math.floor(Math.random() * 90_000_000));
    const created = await accounts.upsert({ platform: "telegram", platformUserId, displayName: "Дым", username: null, photoUrl: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId };
  }

  function service(source: ExpectedTable | null = table, overrides: Record<string, number> = {}): RunsService {
    const runs = new PrismaRunsRepository(prisma);
    const board = new MemoryLeaderboardStore();
    const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
    const scorer = new RunScorer({ get: () => source }, panelSettings(overrides), null);
    return new RunsService(config, runs, board, roles, new RunsHooks(), new RunContinues(), new RunLoadouts(), ratingRestrictions(runs, board).rating, scorer);
  }

  /** Итог по ожидаемому на десятой минуте полосы `average`, как его присылает клиент после T-0292. */
  function finish(patch: Partial<RunFinish> = {}, huntValue?: number): RunFinish {
    const row = expectedRowOf(table, "average", 10);
    return runFinishSchema.parse({
      runId: randomUUID(),
      difficultyId: "hard",
      outcome: "died",
      survivalSec: 600,
      level: 18,
      enemiesKilled: Math.round(row.killsPerMin * 10),
      startingWeaponId: "knife",
      weapons: [{ id: "knife", level: 2 }],
      contentHash: table.contentHash,
      stats: {
        damageTaken: Math.round(row.damageTakenPerMin * 10),
        xpCollected: 100,
        waveReached: 10,
        topKills: [],
        huntLog: [{ rank: "elite", value: huntValue ?? row.huntPerMin * 10, aliveSec: row.huntKillSec.elite }],
        buildScore: row.buildScore,
        power: 2.2,
      },
      ...patch,
    });
  }

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    accounts = new PrismaAccountRepository(prisma);
    const bundled = bundledExpectedTable();
    if (bundled === null) throw new Error("таблица ожидаемого не разобралась");
    table = bundled;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("запись забега кладёт очки, оси, стиль и полосу в строку и в ответ", async () => {
    const me = await account();
    const run = finish();

    const result = await service().finish(me, run);

    const row = await prisma.run.findUnique({ where: { runId: run.runId } });
    expect(row?.points).toBe(result.score?.points);
    expect(row?.points).toBeGreaterThan(900);
    expect(row?.style).toBe("t");
    expect(row?.band).toBe("average");
    expect(row?.axes).toMatchObject({ t: expect.any(Number), k: expect.any(Number), h: expect.any(Number), c: expect.any(Number), b: expect.any(Number) });
    expect(row?.scoreInput).toMatchObject({ power: 2.2 });
  });

  it("повтор итога отвечает теми же очками, не считая их заново", async () => {
    const me = await account();
    const run = finish();
    const first = await service().finish(me, run);

    const second = await service(null).finish(me, run);

    expect(second.score).toEqual(first.score);
  });

  it("пролог (не рейтинговая сложность) — без очков", async () => {
    const me = await account();
    const run = finish({ difficultyId: "easy" });

    const result = await service().finish(me, run);

    expect(result.score).toBeNull();
    const row = await prisma.run.findUnique({ where: { runId: run.runId } });
    expect(row?.points).toBeNull();
    expect(row?.axes).toBeNull();
  });

  it("таблица не загрузилась — забег записан, очки null", async () => {
    const me = await account();
    const run = finish();

    const result = await service(null).finish(me, run);

    expect(result.verdict).toBe("ok");
    const row = await prisma.run.findUnique({ where: { runId: run.runId } });
    expect(row?.status).toBe("finished");
    expect(row?.points).toBeNull();
  });

  it("runs:rescore восстанавливает очки по сохранённым колонкам, а повтор не меняет числа", async () => {
    const me = await account();
    const withTable = finish();
    const withoutTable = finish();
    await service().finish(me, withTable);
    await service(null).finish(me, withoutTable);
    const scorer = new RunScorer({ get: () => table }, panelSettings(), null);
    const repository = new PrismaRunScoresRepository(prisma);
    const own = { since: new Date(Date.now() - 60_000), batchSize: 2 };

    const first = await rescoreRuns(repository, scorer, own);
    const snapshot = await prisma.run.findMany({ where: { accountId: me.accountId }, orderBy: { runId: "asc" }, select: { runId: true, points: true, axes: true, style: true, band: true } });
    const second = await rescoreRuns(repository, scorer, own);
    const again = await prisma.run.findMany({ where: { accountId: me.accountId }, orderBy: { runId: "asc" }, select: { runId: true, points: true, axes: true, style: true, band: true } });

    expect(first.scanned).toBeGreaterThanOrEqual(2);
    expect(snapshot.every((row) => row.points !== null)).toBe(true);
    expect(again).toEqual(snapshot);
    expect(second.unscored).toBe(0);
  });

  it("ключ rating.weight-hunt из панели меняет очки при пересчёте", async () => {
    const me = await account();
    const row = expectedRowOf(table, "average", 10);
    const run = finish({}, row.huntPerMin * 10 * 2);
    const recorded = await service().finish(me, run);
    const repository = new PrismaRunScoresRepository(prisma);
    const heavy = new RunScorer({ get: () => table }, panelSettings({ "rating.weight-hunt": 60 }), null);

    await rescoreRuns(repository, heavy, { since: new Date(Date.now() - 60_000), batchSize: 50 });

    const after = await prisma.run.findUnique({ where: { runId: run.runId } });
    expect(after?.points).toBeGreaterThan(recorded.score?.points ?? 0);
    expect(after?.style).toBe("h");
  });

  it("пересчёт забега без исходных чисел (запись до задачи) идёт по колонкам: средняя полоса, оси охоты и сборки — единица", async () => {
    const me = await account();
    const runId = randomUUID();
    const runs = new PrismaRunsRepository(prisma);
    await runs.finish({
      runId,
      accountId: me.accountId,
      difficulty: "hard",
      startingWeaponId: "knife",
      contentHash: table.contentHash,
      finishedAt: new Date(),
      outcome: "died",
      survivalSec: 600,
      level: 18,
      enemiesKilled: Math.round(expectedRowOf(table, "average", 10).killsPerMin * 10),
      weapons: [{ id: "knife", level: 2 }],
      details: null,
      deathCause: null,
      cheats: false,
      continues: [],
      ranked: true,
      ratingRestricted: null,
      verdict: "ok",
      verdictReasons: [],
      rubezhReached: false,
      rubezhClearedSec: null,
      score: null,
      scoreInput: null,
    });

    await rescoreRuns(new PrismaRunScoresRepository(prisma), new RunScorer({ get: () => table }, panelSettings(), null), { since: new Date(Date.now() - 60_000), batchSize: 50 });

    const row = await prisma.run.findUnique({ where: { runId } });
    expect(row?.band).toBe("average");
    expect(row?.axes).toMatchObject({ h: 1, b: 1, c: 1 });
    expect(row?.points).not.toBeNull();
  });
});
