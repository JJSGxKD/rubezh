import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { createPrisma } from "../src/infra/database.js";
import { REDIS, closeRedis, createRedis } from "../src/infra/redis.js";
import { AchievementsService } from "../src/modules/achievements/achievements.service.js";
import { PrismaAchievementsRepository } from "../src/modules/achievements/achievements.repository.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { CODEX_ENEMY_IDS, CODEX_REWARD_TASK_ID, percentOf } from "../src/modules/codex/codex-rules.js";
import { CodexController } from "../src/modules/codex/codex.controller.js";
import { PrismaCodexRepository } from "../src/modules/codex/codex.repository.js";
import { CodexService, type CodexView } from "../src/modules/codex/codex.service.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PrismaProgressRepository } from "../src/modules/progress/progress.repository.js";
import { ProgressService } from "../src/modules/progress/progress.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Кодекс врагов на живых Postgres и Redis (tasks/T-0127,
 * docs/17-testing-strategy.md §4.2; адреса — TEST_DATABASE_URL и
 * PLAYTEST_TEST_REDIS_URL, без них пропуск). Каталог — из миграции: тест
 * читает три достижения, которые она посеяла. Redis — своя база (сдвиг 13),
 * без `flushdb`: её делят другие файлы.
 *
 * Память этого не покажет: «открыто однажды» держит первичный ключ и
 * `ON CONFLICT DO NOTHING`, а повтор забега и два забега разом — именно то, что
 * ключ обязан выдержать.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

/** среда, 21.10.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 9, 21, 9));
const LATER = new Date(NOON.getTime() + 3_600_000);
const STAMP = String(Date.now());
const TOTAL = CODEX_ENEMY_IDS.length;

describe.skipIf(!live)("кодекс врагов на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let wallet: WalletService;
  let tasks: TasksService;
  let hooks: RunsHooks;
  let codex: CodexService;
  let achievements: AchievementsService;

  async function player(): Promise<AccountRef> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(970_000_000 + Math.floor(Math.random() * 15_000_000)), displayName: "Кодекс", username: null },
      Date.now(),
    );
    return { accountId: created.accountId, platform: "telegram", platformUserId: "1" };
  }

  let runNo = 0;
  function recorded(accountId: string, enemiesSeen: string[], patch: Partial<RecordedRun> = {}): RecordedRun {
    return {
      runId: `codex-it-${STAMP}-${String(runNo++)}`,
      accountId,
      difficulty: "hard",
      outcome: "died",
      survivalSec: 400,
      level: 22,
      enemiesKilled: 400,
      startingWeaponId: "spark",
      weapons: [{ id: "spark", level: 3 }],
      boosts: [],
      xpCollected: 600,
      counters: null,
      enemiesSeen,
      deathCause: null,
      cheats: false,
      continues: 0,
      ranked: true,
      verdict: "ok",
      reasons: [],
      finishedAt: NOON,
      ...patch,
    };
  }

  const entriesOf = async (accountId: string) =>
    await prisma.$queryRaw<{ enemy_id: string; first_seen_at: Date }[]>`SELECT enemy_id, first_seen_at FROM codex_entry WHERE account_id = ${accountId}::uuid ORDER BY enemy_id`;

  const idsOf = (view: CodexView): string[] => view.opened.map((entry) => entry.enemy).sort();

  async function taskRow(accountId: string, taskId: string): Promise<{ value: number; done: boolean } | undefined> {
    const rows = await prisma.$queryRaw<{ value: number; done: boolean }[]>`
      SELECT value::int AS value, (completed_at IS NOT NULL) AS done FROM task_progress WHERE account_id = ${accountId}::uuid AND task_id = ${taskId}`;
    return rows[0];
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    const unused = {} as never;
    hooks = new RunsHooks();
    tasks = new TasksService(new PrismaTasksRepository(prisma), wallet, hooks, unused, unused, unused, unused);
    codex = new CodexService(new PrismaCodexRepository(prisma), tasks, hooks);
    const friends = new PrismaFriendsRepository(prisma);
    achievements = new AchievementsService(
      tasks,
      new PrismaAchievementsRepository(prisma),
      { friendCount: (accountId) => friends.count(accountId) },
      new ProgressService(new PrismaProgressRepository(prisma)),
      panelSettings(),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  beforeEach(() => {
    // Строки лога модуля в вывод тестов не попадают.
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("запись по итогу забега", () => {
    it("забег с тремя врагами открывает три записи", async () => {
      const me = await player();
      const three = CODEX_ENEMY_IDS.slice(0, 3);
      await codex.onRun(recorded(me.accountId, three));
      expect((await entriesOf(me.accountId)).map((row) => row.enemy_id)).toEqual([...three].sort());
    });

    it("тот же забег, записанный повторно, ничего нового не открывает", async () => {
      const me = await player();
      const run = recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, 3));
      await codex.onRun(run);
      const before = await entriesOf(me.accountId);
      await codex.onRun({ ...run, finishedAt: LATER });
      await Promise.all([codex.onRun(run), codex.onRun(run)]);
      expect(await entriesOf(me.accountId)).toEqual(before);
    });

    it("второй забег добавляет одну запись, а прежние first_seen_at не меняются", async () => {
      const me = await player();
      const [a = "", b = "", c = "", d = ""] = CODEX_ENEMY_IDS;
      await codex.onRun(recorded(me.accountId, [a, b, c]));
      const before = await entriesOf(me.accountId);
      await codex.onRun(recorded(me.accountId, [b, c, d], { finishedAt: LATER }));
      const after = await entriesOf(me.accountId);
      expect(after.map((row) => row.enemy_id)).toEqual([a, b, c, d].sort());
      for (const row of before) expect(after.find((other) => other.enemy_id === row.enemy_id)?.first_seen_at, row.enemy_id).toEqual(row.first_seen_at);
      expect(after.find((row) => row.enemy_id === d)?.first_seen_at).toEqual(LATER);
    });

    it("забег с читом и забег, отклонённый разбором, записей не открывают", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, 3), { cheats: true }));
      await codex.onRun(recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, 3), { verdict: "rejected" }));
      expect(await entriesOf(me.accountId)).toEqual([]);
    });

    it("id вне списка не пишется", async () => {
      const me = await player();
      const first = CODEX_ENEMY_IDS[0] ?? "";
      await codex.onRun(recorded(me.accountId, ["not_an_enemy", "'; DROP TABLE codex_entry; --", first]));
      expect((await entriesOf(me.accountId)).map((row) => row.enemy_id)).toEqual([first]);
    });

    it("сбой хранилища слушатель не пробрасывает: забег он не ломает", async () => {
      const broken = new CodexService(
        {
          opened: async () => {
            throw new Error("база недоступна");
          },
          open: async () => [],
        },
        tasks,
        new RunsHooks(),
      );
      const me = await player();
      await expect(broken.onRun(recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, 1)))).resolves.toBeUndefined();
    });

    it("слушатель подписан на запись забега: событие хуков открывает записи", async () => {
      const own = new RunsHooks();
      const service = new CodexService(new PrismaCodexRepository(prisma), tasks, own);
      service.onModuleInit();
      const me = await player();
      await own.emit(recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, 2)));
      expect(await entriesOf(me.accountId)).toHaveLength(2);
    });
  });

  describe("процент и достижения лестницы", () => {
    it("открыто треть кодекса: codex_percent посчитан, «Первые наброски» выполнено, «Знаток тварей» нет", async () => {
      const me = await player();
      const opened = Math.ceil((TOTAL * 30) / 100);
      await codex.onRun(recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, opened)));
      const percent = percentOf(opened, TOTAL);
      expect(percent).toBeGreaterThanOrEqual(30);
      expect(percent).toBeLessThan(60);
      expect(await taskRow(me.accountId, "ach_codex_30")).toEqual({ value: 30, done: true });
      expect((await taskRow(me.accountId, "ach_codex_60"))?.done ?? false).toBe(false);
      expect((await taskRow(me.accountId, "ach_codex_60"))?.value).toBe(percent);
    });

    it("витрина достижений не затирает процент уровнем аккаунта", async () => {
      const me = await player();
      const opened = Math.ceil((TOTAL * 30) / 100);
      await codex.onRun(recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, opened)));
      await prisma.$executeRaw`INSERT INTO account_progress (account_id, xp, level, updated_at) VALUES (${me.accountId}::uuid, 0, 12, now())`;
      await achievements.view(me, NOON);
      expect((await taskRow(me.accountId, "ach_codex_60"))?.value).toBe(percentOf(opened, TOTAL));
    });

    it("три строки каталога: цели 30/60/100, престиж 5/10/20, монеты 100/200/400, категория «коллекция»", async () => {
      const rows = await prisma.$queryRaw<
        { task_id: string; kind: string; target: number; prestige: number; coins: number; gems: number; shards: number; category: string; ladder: string; rung: number; active: boolean; period: string }[]
      >`SELECT task_id, kind, target, prestige, coins, gems, shards, category, ladder, rung, active, period::text AS period FROM task_def WHERE kind = 'codex_percent' ORDER BY rung`;
      expect(rows.map((row) => [row.task_id, row.target, row.prestige, row.coins])).toEqual([
        ["ach_codex_30", 30, 5, 100],
        ["ach_codex_60", 60, 10, 200],
        ["ach_codex_100", 100, 20, 400],
      ]);
      for (const row of rows) expect(row).toMatchObject({ kind: "codex_percent", gems: 0, shards: 0, category: "collection", ladder: "codex", active: true, period: "achievement" });
      expect(rows.map((row) => row.rung)).toEqual([1, 2, 3]);
    });
  });

  describe("GET /codex", () => {
    it("у нового аккаунта ничего не открыто, процент ноль, награда описана", async () => {
      const me = await player();
      const view = await codex.view(me, NOON);
      expect(view).toMatchObject({ total: TOTAL, opened: [], percent: 0 });
      expect(view.reward).toEqual({ taskId: CODEX_REWARD_TASK_ID, value: 0, target: 100, done: false, claimed: false, coins: 400, prestige: 20 });
    });

    it("отдаёт открытые записи с временем первой встречи", async () => {
      const me = await player();
      const [a = "", b = ""] = CODEX_ENEMY_IDS;
      await codex.onRun(recorded(me.accountId, [a, b]));
      const view = await codex.view(me, NOON);
      expect(idsOf(view)).toEqual([a, b].sort());
      expect(view.opened.every((entry) => entry.firstSeenAt === NOON.toISOString())).toBe(true);
      expect(view.percent).toBe(percentOf(2, TOTAL));
    });

    it("дописывает значение для старого аккаунта, которому хук записи не открывал: записи есть, прогресса нет", async () => {
      const me = await player();
      const ids = CODEX_ENEMY_IDS.slice(0, Math.ceil((TOTAL * 60) / 100));
      await prisma.$executeRaw`INSERT INTO codex_entry (account_id, enemy_id, first_seen_at) SELECT ${me.accountId}::uuid, e, ${NOON} FROM unnest(${ids}::text[]) AS e`;
      expect(await taskRow(me.accountId, "ach_codex_60")).toBeUndefined();
      await codex.view(me, NOON);
      expect((await taskRow(me.accountId, "ach_codex_60"))?.done).toBe(true);
    });

    it("значение не убывает: враг добавлен в таблицу — процент ответа ниже, выполненное остаётся выполненным", async () => {
      const me = await player();
      const opened = Math.ceil((TOTAL * 30) / 100);
      await codex.onRun(recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, opened)));
      const before = await codex.view(me, NOON);
      expect(before.percent).toBe(percentOf(opened, TOTAL));
      // Список вырос: тот же набор записей — меньший процент.
      const grown = percentOf(opened, TOTAL + 20);
      expect(grown).toBeLessThan(before.percent);
      expect((await taskRow(me.accountId, "ach_codex_30"))?.done).toBe(true);
      await codex.view(me, NOON);
      expect((await taskRow(me.accountId, "ach_codex_30"))?.done).toBe(true);
    });

    it("награда выключена в панели — reward: null, ответ остальное отдаёт", async () => {
      const me = await player();
      await prisma.$executeRaw`UPDATE task_def SET active = false WHERE task_id = ${CODEX_REWARD_TASK_ID}`;
      try {
        tasks.forgetCatalog();
        const view = await codex.view(me, NOON);
        expect(view.reward).toBeNull();
        expect(view.total).toBe(TOTAL);
      } finally {
        await prisma.$executeRaw`UPDATE task_def SET active = true WHERE task_id = ${CODEX_REWARD_TASK_ID}`;
        tasks.forgetCatalog();
      }
    });

    it("полный кодекс — 100%, забор «Полного кодекса» один раз начисляет 400 монет, повтор — нет", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, [...CODEX_ENEMY_IDS]));
      const view = await codex.view(me, NOON);
      expect(view.percent).toBe(100);
      expect(view.reward).toMatchObject({ done: true, claimed: false, value: 100, coins: 400, prestige: 20 });

      const before = (await wallet.balances(me.accountId)).coins;
      const first = await tasks.claim(me, CODEX_REWARD_TASK_ID, NOON);
      expect(first.claimed).toBe(true);
      expect(first.credited.coins).toBe(400);
      const second = await tasks.claim(me, CODEX_REWARD_TASK_ID, NOON);
      expect(second.claimed).toBe(false);
      expect((await wallet.balances(me.accountId)).coins).toBe(before + 400);
      expect((await codex.view(me, NOON)).reward).toMatchObject({ done: true, claimed: true });
    });
  });

  describe("аккаунт и вайп", () => {
    it("записи уходят вместе с аккаунтом (ON DELETE CASCADE)", async () => {
      const me = await player();
      await codex.onRun(recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, 2)));
      expect(await entriesOf(me.accountId)).toHaveLength(2);
      await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me.accountId}::uuid`;
      expect(await entriesOf(me.accountId)).toEqual([]);
    });

    it("база не принимает запись чужого аккаунта и повтор пары", async () => {
      const me = await player();
      const enemy = CODEX_ENEMY_IDS[0] ?? "";
      await expect(prisma.$executeRaw`INSERT INTO codex_entry (account_id, enemy_id, first_seen_at) VALUES (${"00000000-0000-4000-8000-000000000000"}::uuid, ${enemy}, now())`).rejects.toThrow();
      await prisma.$executeRaw`INSERT INTO codex_entry (account_id, enemy_id, first_seen_at) VALUES (${me.accountId}::uuid, ${enemy}, now())`;
      await expect(prisma.$executeRaw`INSERT INTO codex_entry (account_id, enemy_id, first_seen_at) VALUES (${me.accountId}::uuid, ${enemy}, now())`).rejects.toThrow();
    });
  });

  describe("миграция только добавляет", () => {
    it("таблица codex_entry с первичным ключом (аккаунт, враг), три новые строки каталога, прежние достижения на месте", async () => {
      const columns = await prisma.$queryRaw<{ column_name: string; is_nullable: string }[]>`
        SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'codex_entry' ORDER BY column_name`;
      expect(columns.map((column) => column.column_name)).toEqual(["account_id", "enemy_id", "first_seen_at"]);
      expect(columns.every((column) => column.is_nullable === "NO")).toBe(true);
      const keys = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT a.attname AS column_name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'codex_entry'::regclass AND i.indisprimary ORDER BY a.attname`;
      expect(keys.map((key) => key.column_name)).toEqual(["account_id", "enemy_id"]);
      const [kept] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM task_def WHERE task_id IN ('ach_survive_1', 'ach_friends_25', 'ach_kills_100')`;
      expect(kept?.count).toBe(3);
    });
  });

  describe("по HTTP", () => {
    let app: NestFastifyApplication | null = null;

    afterEach(async () => {
      await app?.close();
      app = null;
    });

    it("без токена — 401; с токеном ответ по форме из задачи", async () => {
      @Module({
        controllers: [CodexController],
        providers: [{ provide: APP_CONFIG, useValue: config }, { provide: REDIS, useValue: redis }, { provide: CodexService, useValue: codex }, RateLimiter, AuthGuard],
      })
      class TestModule {}
      app = await createHttpApp(TestModule, { logger: false });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      const me = await player();
      await codex.onRun(recorded(me.accountId, CODEX_ENEMY_IDS.slice(0, 2)));
      const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: me.platformUserId }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());

      expect((await app.inject({ method: "GET", url: "/api/v1/codex" })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url: "/api/v1/codex", headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: CodexView }>().data;
      expect(Object.keys(body).sort()).toEqual(["opened", "percent", "reward", "total"]);
      expect(body.total).toBe(TOTAL);
      expect(body.opened).toHaveLength(2);
      expect(Object.keys(body.opened[0] ?? {}).sort()).toEqual(["enemy", "firstSeenAt"]);
    });
  });
});
