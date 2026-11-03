import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { rebuildLeaderboard } from "../src/modules/runs/leaderboard-rebuild.js";
import { ratingSinceOf } from "../src/modules/runs/rated-runs.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunProofsService } from "../src/modules/runs/run-proofs.service.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { RunsController } from "../src/modules/runs/runs.controller.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { PrismaRunsRepository, type RunFinishRecord } from "../src/modules/runs/runs.repository.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RunsViewService, type LeaderboardView } from "../src/modules/runs/runs-view.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { POOL_QUOTA, pickPool } from "../src/modules/tasks/task-pool.js";
import { POOL_TIERS } from "../src/modules/tasks/task-rules.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, ratingRestrictions } from "./helpers/memory-runs.js";
import { testPrisma } from "./helpers/test-prisma.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Единая сложность на живом Postgres (tasks/T-0191, Р126;
 * docs/17-testing-strategy.md §4.2; адрес — TEST_DATABASE_URL, без него
 * пропуск): миграция данных, запросы рейтинга с отсечкой и ответ по HTTP.
 *
 * Redis не нужен: доски в HTTP-части собирает пересборка в память из настоящей
 * таблицы `run`. База общая с соседними файлами, поэтому тест смотрит только
 * на свои аккаунты и берёт время в 2030-х, когда соседи не играют.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const HOUR = 3_600_000;
/** Отсечка теста: полночь 1 января 2031 по UTC */
const SINCE_NUMBER = 20310101;
const SINCE = new Date(Date.UTC(2031, 0, 1));
const BEFORE = new Date(SINCE.getTime() - 1_000);
const AFTER = new Date(SINCE.getTime() + 3 * HOUR);

/** Запись откатывается: пусть тест правит `app_setting` и `task_def`, а соседи ничего не заметят. */
class Rollback extends Error {}

function migrationSql(): string {
  const directory = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
  const names = readdirSync(directory).filter((name) => name.endsWith("_single_difficulty"));
  if (names.length !== 1) throw new Error(`миграция single_difficulty должна быть одна, найдено: ${String(names.length)}`);
  return readFileSync(`${directory}${names[0] ?? ""}/migration.sql`, "utf8");
}

/** Операторы миграции по одному: подготовленный запрос Prisma не принимает несколько команд сразу. */
function statementsOf(sql: string): string[] {
  const code = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return code
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

describe.skipIf(DATABASE_URL === "")("единая сложность на живом Postgres", () => {
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let runs: PrismaRunsRepository;
  let config: AppConfig;
  let app: NestFastifyApplication | null = null;

  async function account(name = "Рейтинг"): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(700_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: name, username: null, photoUrl: null }, Date.now());
    return created.accountId;
  }

  function record(accountId: string, difficulty: RunFinishRecord["difficulty"], survivalSec: number, finishedAt: Date, patch: Partial<RunFinishRecord> = {}): RunFinishRecord {
    return {
      runId: randomUUID(),
      accountId,
      difficulty,
      startingWeaponId: "knife",
      contentHash: "abc",
      finishedAt,
      outcome: "died",
      survivalSec,
      level: 6,
      enemiesKilled: 300,
      weapons: [{ id: "knife", level: 2 }],
      details: null,
      deathCause: null,
      cheats: false,
      continues: [],
      // Как в базе после прошлой жизни: рейтинговым был любой честный забег.
      ranked: true,
      ratingRestricted: null,
      verdict: "ok",
      verdictReasons: [],
      rubezhReached: false,
      rubezhClearedSec: null,
      ...patch,
    };
  }

  async function save(row: RunFinishRecord): Promise<RunFinishRecord> {
    expect(await runs.finish(row)).toBe("finished");
    return row;
  }

  beforeAll(() => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL } as NodeJS.ProcessEnv);
    prisma = testPrisma(DATABASE_URL, 10);
    accounts = new PrismaAccountRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("миграция данных", () => {
    it("отсечка рейтинга есть в настройках: число ГГГГММДД — день применения миграции по UTC", async () => {
      const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS.ratingSinceDate.key } });

      expect(row).not.toBeNull();
      expect(typeof row?.value).toBe("number");
      const value = row?.value as number;
      expect(ratingSinceOf(value), `значение ${String(value)} не дата ГГГГММДД`).not.toBeNull();
      expect(SETTINGS.ratingSinceDate.schema.safeParse(value).success).toBe(true);
      // База миграется в день прогона; сутки запаса — на прогон, перешагнувший полночь.
      const today = Date.now();
      const yesterday = today - 24 * HOUR;
      const asNumber = (at: number) => Number(new Date(at).toISOString().slice(0, 10).replaceAll("-", ""));
      expect([asNumber(today), asNumber(yesterday)]).toContain(value);
    });

    it("повторный прогон SQL миграции не перезаписывает заданную дату, вставляет её, если строки нет, и добивает задания; схему не трогает", async () => {
      const statements = statementsOf(migrationSql());
      expect(statements.length).toBeGreaterThanOrEqual(2);
      // Никаких изменений схемы: только данные.
      for (const statement of statements) expect(statement, statement).toMatch(/^(INSERT INTO|UPDATE) "(app_setting|task_def)"/);

      const seen: Record<string, unknown> = {};
      const run = async (tx: Pick<PrismaClient, "$executeRawUnsafe">) => {
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
      };
      await expect(
        prisma.$transaction(async (tx) => {
          // Строки нет — миграция её вставляет сегодняшним днём.
          await tx.appSetting.deleteMany({ where: { key: "rating.since-date" } });
          await run(tx);
          seen.inserted = (await tx.appSetting.findUnique({ where: { key: "rating.since-date" } }))?.value;
          // Дата задана заранее (панель или прошлый прогон) — второй прогон её не трогает.
          await tx.appSetting.update({ where: { key: "rating.since-date" }, data: { value: 20300101 } });
          await run(tx);
          seen.kept = (await tx.appSetting.findUnique({ where: { key: "rating.since-date" } }))?.value;

          // Задания: строки с фильтром easy/normal выключены, остальные не затронуты.
          await tx.$executeRawUnsafe(`UPDATE "task_def" SET "active" = true WHERE "task_id" IN ('daily_normal_runs')`);
          await tx.$executeRawUnsafe(`
            INSERT INTO "task_def" ("task_id", "period", "kind", "target", "coins", "shards", "sort", "tier", "filter", "created_at", "updated_at") VALUES
              ('it_diff_easy', 'daily', 'difficulty_survive_sec', 60, 10, 0, 900, 'easy', '{"difficulty":"easy"}'::jsonb, now(), now()),
              ('it_diff_hard', 'daily', 'difficulty_survive_sec', 60, 10, 0, 901, 'easy', '{"difficulty":"hard"}'::jsonb, now(), now()),
              ('it_weapon', 'daily', 'weapon_runs', 2, 10, 0, 902, 'easy', '{"weapon":"knife"}'::jsonb, now(), now()),
              ('it_plain', 'daily', 'kills', 100, 10, 0, 903, 'easy', NULL, now(), now())`);
          await run(tx);
          const active = await tx.$queryRawUnsafe<{ task_id: string; active: boolean }[]>(`SELECT task_id, active FROM task_def WHERE task_id IN ('daily_normal_runs', 'it_diff_easy', 'it_diff_hard', 'it_weapon', 'it_plain') ORDER BY task_id`);
          seen.tasks = Object.fromEntries(active.map((row) => [row.task_id, row.active]));
          // Ещё один прогон: выключенное остаётся выключенным, число изменённых строк не растёт.
          await run(tx);
          const again = await tx.$queryRawUnsafe<{ task_id: string; active: boolean }[]>(`SELECT task_id, active FROM task_def WHERE task_id IN ('daily_normal_runs', 'it_diff_easy') ORDER BY task_id`);
          seen.again = Object.fromEntries(again.map((row) => [row.task_id, row.active]));
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);

      expect(seen.inserted).toBe(Number(new Date().toISOString().slice(0, 10).replaceAll("-", "")));
      expect(seen.kept).toBe(20300101);
      expect(seen.tasks).toEqual({ daily_normal_runs: false, it_diff_easy: false, it_diff_hard: true, it_plain: true, it_weapon: true });
      expect(seen.again).toEqual({ daily_normal_runs: false, it_diff_easy: false });
    });

    it("задания: «нормальная» выключена, «сложная» работают, строки без фильтра сложности на месте", async () => {
      const rows = await prisma.$queryRaw<{ task_id: string; active: boolean }[]>`
        SELECT task_id, active FROM task_def WHERE task_id IN ('daily_normal_runs', 'daily_hard_run', 'daily_hard_180', 'weekly_hard_240', 'daily_best_240', 'daily_weapon_knife', 'daily_element_fire', 'daily_xp_1500')`;
      const byId = new Map(rows.map((row) => [row.task_id, row.active]));

      expect(byId.get("daily_normal_runs")).toBe(false);
      for (const id of ["daily_hard_run", "daily_hard_180", "weekly_hard_240", "daily_best_240", "daily_weapon_knife", "daily_element_fire", "daily_xp_1500"]) expect(byId.get(id), id).toBe(true);
      // Выключенных строк с фильтром easy/normal среди включённых нет вовсе.
      const leftovers = await prisma.$queryRaw<{ task_id: string }[]>`
        SELECT task_id FROM task_def WHERE active AND kind IN ('difficulty_runs', 'difficulty_survive_sec') AND filter ->> 'difficulty' IN ('easy', 'normal') AND task_id NOT LIKE 'it\\_%'`;
      expect(leftovers).toEqual([]);
    });

    it("набор дня на каждую из 30 дат подряд — ровно квота (2 + 2 + 1), без выключенной строки; недельный — 2 + 3 + 1", async () => {
      const catalog = await new PrismaTasksRepository(prisma).catalog();
      const dailyQuota = POOL_TIERS.reduce((sum, tier) => sum + POOL_QUOTA.daily[tier], 0);
      expect(dailyQuota).toBe(5);

      for (let day = 0; day < 30; day++) {
        const date = new Date(Date.UTC(2026, 10, 1 + day)).toISOString().slice(0, 10);
        const picked = pickPool(catalog, "daily", date);
        expect(picked.size, date).toBe(dailyQuota);
        expect(picked.has("daily_normal_runs"), date).toBe(false);
        for (const tier of POOL_TIERS) {
          const inTier = catalog.filter((task) => picked.has(task.taskId) && task.tier === tier);
          expect(inTier.length, `${date} ${tier}`).toBe(POOL_QUOTA.daily[tier]);
        }
      }
      for (let week = 0; week < 8; week++) {
        const monday = new Date(Date.UTC(2026, 10, 2 + week * 7)).toISOString().slice(0, 10);
        expect(pickPool(catalog, "weekly", monday).size, monday).toBe(POOL_TIERS.reduce((sum, tier) => sum + POOL_QUOTA.weekly[tier], 0));
      }
    });
  });

  describe("запросы рейтинга с отсечкой", () => {
    it("лучшее, пересборка и список модератора берут только единую сложность не раньше отсечки; setRanked не трогает старое", async () => {
      const id = await account();
      const olderHard = await save(record(id, "hard", 900, BEFORE));
      const newHard = await save(record(id, "hard", 300, AFTER));
      const easy = await save(record(id, "easy", 800, AFTER));
      const normal = await save(record(id, "normal", 700, AFTER));
      const atCutoff = await save(record(id, "hard", 250, SINCE));

      expect((await runs.bestRunOf(id, "hard", false, SINCE))?.survivalSec).toBe(300);
      expect((await runs.bestRunOf(id, "hard", false, null))?.survivalSec).toBe(900);
      expect(await runs.bestRunOf(id, "easy", false, SINCE)).toBeNull();
      expect(await runs.bestRunOf(id, "normal", true, SINCE)).toBeNull();

      expect((await runs.bestRuns([id], "hard", SINCE)).map((row) => row.survivalSec)).toEqual([300]);
      expect(await runs.bestRuns([id], "easy", SINCE)).toEqual([]);

      expect((await runs.bestTimes("hard", SINCE)).find((row) => row.accountId === id)?.survivalSec).toBe(300);
      expect(await runs.bestTimes("easy", SINCE)).toEqual([]);
      expect(await runs.bestTimes("normal", SINCE)).toEqual([]);

      expect((await runs.moderationRuns(id, "hard", 10, SINCE)).map((row) => row.runId).sort()).toEqual([newHard.runId, atCutoff.runId].sort());
      expect(await runs.moderationRuns(id, "easy", 10, SINCE)).toEqual([]);
      expect(await runs.moderationRuns(id, "normal", 10, SINCE)).toEqual([]);

      // Старое и нерейтинговое снять и вернуть нельзя; база не меняется.
      for (const row of [olderHard, easy, normal]) {
        expect(await runs.setRanked(row.runId, false, SINCE), row.runId).toBeNull();
        expect(await runs.setRanked(row.runId, true, SINCE), row.runId).toBeNull();
        expect((await runs.find(row.runId))?.ranked, row.runId).toBe(true);
      }
      expect(await runs.setRanked(newHard.runId, false, SINCE)).toMatchObject({ accountId: id, difficulty: "hard", survivalSec: 300 });
      expect(await runs.setRanked(newHard.runId, true, SINCE)).toMatchObject({ survivalSec: 300 });
      // Без отсечки старое hard снимается, как раньше: отсечка — единственное, что его удерживало.
      expect(await runs.setRanked(olderHard.runId, false, null)).toMatchObject({ survivalSec: 900 });
    });

    it("забег, снятый модератором, и нерейтинговый не путаются: «вернуть» работает только для первого", async () => {
      const id = await account();
      const moderated = await save(record(id, "hard", 400, AFTER, { ranked: false }));
      // Нерейтинговая сложность выглядит так же, как снятый модератором: честный вердикт, нет читов, ranked = false.
      const trainee = await save(record(id, "easy", 500, AFTER, { ranked: false }));

      expect(await runs.setRanked(trainee.runId, true, SINCE)).toBeNull();
      expect(await runs.setRanked(moderated.runId, true, SINCE)).toMatchObject({ survivalSec: 400 });
      expect((await runs.moderationRuns(id, "easy", 10, SINCE))).toEqual([]);
    });
  });

  describe("ответ по HTTP", () => {
    async function boot(board: MemoryLeaderboardStore, settings = panelSettings({ [SETTINGS.ratingSinceDate.key]: SINCE_NUMBER })) {
      const rating = ratingRestrictions(runs, board, undefined, settings);
      const roles = new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository());
      const service = new RunsService(config, runs, board, roles, new RunsHooks(), new RunContinues(), new RunLoadouts(), rating.rating);
      const view = new RunsViewService(runs, board, new RunExtras(), rating.rating, new RunPrestige());
      @Module({
        controllers: [RunsController],
        providers: [
          { provide: APP_CONFIG, useValue: config },
          { provide: RunsService, useValue: service },
          { provide: RunsViewService, useValue: view },
          { provide: RateLimiter, useValue: { consume: async () => true } },
          { provide: RunProofsService, useValue: {} },
          AuthGuard,
        ],
      })
      class TestModule {}
      app = await createHttpApp(TestModule, { logger: false });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      return { rating, service };
    }

    async function headersOf(accountId: string): Promise<Record<string, string>> {
      const me: AccountRef = { accountId, platform: "telegram", platformUserId: accountId.slice(0, 9) };
      const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: me.platformUserId }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
      return { authorization: `Bearer ${token}` };
    }

    it("GET /leaderboard: easy и normal — 200 и пустая доска, hard — только забеги после отсечки", async () => {
      const board = new MemoryLeaderboardStore();
      const { rating } = await boot(board);
      const [early, late, trainee] = [await account("Ранний"), await account("Поздний"), await account("Обучение")];
      // Времена выше любых соседних тестов: первые места доски — наши.
      await save(record(early, "hard", 80_000, BEFORE));
      await save(record(late, "hard", 70_000, AFTER));
      await save(record(trainee, "easy", 85_000, AFTER));
      await save(record(trainee, "normal", 84_000, AFTER));
      await rebuildLeaderboard(runs, board, new Set(), new Set(), rating.rating.since());
      const http = app;
      if (http === null) throw new Error("приложение не запущено");
      const headers = await headersOf(late);

      for (const difficulty of ["easy", "normal"] as const) {
        const response = await http.inject({ method: "GET", url: `/api/v1/runs/leaderboard?difficulty=${difficulty}`, headers });
        expect(response.statusCode, difficulty).toBe(200);
        expect(response.json<{ data: LeaderboardView }>().data).toEqual({ difficultyId: difficulty, entries: [], me: null, totalPlayers: 0 });
      }

      const hard = await http.inject({ method: "GET", url: "/api/v1/runs/leaderboard?difficulty=hard", headers });
      expect(hard.statusCode).toBe(200);
      const body = hard.json<{ data: LeaderboardView }>().data;
      expect(body.difficultyId).toBe("hard");
      expect(body.entries[0]).toMatchObject({ rank: 1, survivalSec: 70_000, isMe: true });
      expect(body.me).toEqual({ rank: 1, survivalSec: 70_000 });
      expect(JSON.stringify(body)).not.toContain("80000");
      expect(JSON.stringify(body)).not.toContain("85000");
      expect(JSON.stringify(body)).not.toContain(early);

      // Старый клиент: прежняя форма ответа и без `difficulty` — всё та же ошибка, не 500.
      expect((await http.inject({ method: "GET", url: "/api/v1/runs/leaderboard?difficulty=nightmare", headers })).statusCode).toBe(400);
    });

    it("POST /runs: старый клиент присылает easy и normal — 201, recorded false, места нет; hard — в рейтинге", async () => {
      const board = new MemoryLeaderboardStore();
      await boot(board, panelSettings());
      const http = app;
      if (http === null) throw new Error("приложение не запущено");
      const me = await account("Старый клиент");
      const headers = await headersOf(me);
      const body = (difficultyId: string) => ({
        runId: randomUUID(),
        difficultyId,
        outcome: "died",
        survivalSec: 120,
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
      });

      for (const difficulty of ["easy", "normal"] as const) {
        const response = await http.inject({ method: "POST", url: "/api/v1/runs", headers, payload: body(difficulty) });
        expect(response.statusCode, difficulty).toBe(201);
        expect(response.json<{ data: unknown }>().data).toEqual({ recorded: false, verdict: "ok", bestSurvivalSec: 0, isNewBest: false, rank: null });
      }
      const hard = await http.inject({ method: "POST", url: "/api/v1/runs", headers, payload: body("hard") });
      expect(hard.statusCode).toBe(201);
      expect(hard.json<{ data: unknown }>().data).toMatchObject({ recorded: true, rank: expect.any(Number) });
      // История целостна: все три забега в базе, рейтинговый один.
      const stored = await prisma.run.findMany({ where: { accountId: me, status: "finished" }, select: { difficulty: true, ranked: true } });
      expect(stored.map((row) => [row.difficulty, row.ranked]).sort()).toEqual([["easy", false], ["hard", true], ["normal", false]]);
    });
  });
});
