import { randomBytes } from "node:crypto";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WEAPONS } from "../../../packages/core-game/src/content/weapons";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { createPrisma } from "../src/infra/database.js";
import { REDIS, closeRedis, createRedis } from "../src/infra/redis.js";
import { AchievementRarityJob } from "../src/modules/achievements/achievement-rarity.job.js";
import { AchievementNotUnlockedError } from "../src/modules/achievements/achievement-errors.js";
import { RARITY_LOCK_KEY, type AchievementsView, type OpenAchievement } from "../src/modules/achievements/achievement-rules.js";
import { AchievementsController } from "../src/modules/achievements/achievements.controller.js";
import { PrismaAchievementsRepository, type AchievementsRepository } from "../src/modules/achievements/achievements.repository.js";
import { AchievementsService } from "../src/modules/achievements/achievements.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PrismaProgressRepository } from "../src/modules/progress/progress.repository.js";
import { ProgressService } from "../src/modules/progress/progress.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { ELEMENTS, TASK_KIND_IDS, type TaskDef } from "../src/modules/tasks/task-rules.js";
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
 * Достижения с престижем на живых Postgres и Redis (tasks/T-0106,
 * docs/17-testing-strategy.md §4.2; адреса — TEST_DATABASE_URL и
 * PLAYTEST_TEST_REDIS_URL, без них пропуск). Каталог — из миграции: тест
 * читает то, что она посеяла. Redis — своя база (сдвиг 13), без `flushdb`:
 * её делит ещё один файл.
 *
 * Память этого не покажет: суммы престижа считает один запрос с `GROUP BY`,
 * редкость — один запрос по населению с `EXISTS` и замена таблицы одной
 * транзакцией, избранное держат первичный и уникальный ключи, а «одна
 * реплика за раз» — это лок Redis, а не флаг процесса.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

/** среда, 21.10.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 9, 21, 9));
const HOUR = 3_600_000;
const STAMP = String(Date.now());

/** Девять существующих достижений: цель и награда не меняются миграцией. */
const OLD: Readonly<Record<string, { target: number; coins: number; gems: number; title: string }>> = {
  ach_survive_1: { target: 60, coins: 100, gems: 0, title: "Первая минута" },
  ach_survive_5: { target: 300, coins: 0, gems: 5, title: "Держи рубеж" },
  ach_survive_10: { target: 600, coins: 0, gems: 10, title: "Несокрушимый" },
  ach_survive_20: { target: 1200, coins: 0, gems: 20, title: "Последний рубеж" },
  ach_runs_10: { target: 10, coins: 300, gems: 0, title: "Бывалый" },
  ach_runs_50: { target: 50, coins: 0, gems: 10, title: "Ветеран" },
  ach_runs_200: { target: 200, coins: 0, gems: 25, title: "Старожил" },
  ach_kills_50k: { target: 50_000, coins: 0, gems: 15, title: "Гроза орды" },
  ach_level_40: { target: 40, coins: 0, gems: 10, title: "Мастер забега" },
};

describe.skipIf(!live)("достижения на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let tasksRepository: PrismaTasksRepository;
  let repository: PrismaAchievementsRepository;
  let wallet: WalletService;
  let tasks: TasksService;
  let service: AchievementsService;
  let catalog: TaskDef[];
  const settings = panelSettings();

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(980_000_000 + Math.floor(Math.random() * 15_000_000)), displayName: "Достижения", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function player(): Promise<AccountRef> {
    return { accountId: await account(), platform: "telegram", platformUserId: "1" };
  }

  let runNo = 0;
  function recorded(accountId: string, patch: Partial<RecordedRun> = {}): RecordedRun {
    return {
      runId: `ach-it-${STAMP}-${String(runNo++)}`,
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

  /** Строка забега в таблице: по ней игрок входит в население редкости. */
  async function finishedRun(accountId: string): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO run (run_id, account_id, status, difficulty, starting_weapon_id, content_hash, finished_at, survival_sec)
      VALUES (${`ach-row-${randomBytes(6).toString("hex")}`}, ${accountId}::uuid, 'finished'::"RunStatus", 'hard', 'spark', 'hash', ${NOON}, 100)`;
  }

  /** Достижения выполнены напрямую, мимо забега: так проверяется то, что от забега не зависит. */
  async function complete(accountId: string, ...taskIds: string[]): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO task_progress (account_id, task_id, period_start, value, target, completed_at, updated_at)
      SELECT ${accountId}::uuid, d.task_id, DATE '2000-01-01', d.target, d.target, ${NOON}, ${NOON}
      FROM task_def d WHERE d.task_id = ANY(${taskIds}::text[])
      ORDER BY d.sort, d.task_id
      ON CONFLICT (account_id, task_id, period_start) DO NOTHING`;
  }

  async function befriend(accountId: string, count: number): Promise<string[]> {
    const friends: string[] = [];
    for (let index = 0; index < count; index++) {
      const friend = await account();
      const [a, b] = accountId < friend ? [accountId, friend] : [friend, accountId];
      await prisma.$executeRaw`INSERT INTO friendship (account_a, account_b, source) VALUES (${a}::uuid, ${b}::uuid, 'link'::"FriendSource")`;
      friends.push(friend);
    }
    return friends;
  }

  const idsOf = (view: AchievementsView): string[] => view.items.map((item) => item.id);
  const itemOf = (view: AchievementsView, id: string) => view.items.find((item) => item.id === id);
  /** Открытые строки витрины: у закрытого скрытого процента нет вовсе. */
  const openOf = (view: AchievementsView): OpenAchievement[] => view.items.filter((item): item is OpenAchievement => "kind" in item);

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    tasksRepository = new PrismaTasksRepository(prisma);
    repository = new PrismaAchievementsRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    const unused = {} as never;
    tasks = new TasksService(tasksRepository, wallet, new RunsHooks(), unused, unused, unused, unused);
    const friends = new PrismaFriendsRepository(prisma);
    service = new AchievementsService(tasks, repository, { friendCount: (accountId) => friends.count(accountId) }, new ProgressService(new PrismaProgressRepository(prisma)), settings);
    catalog = (await tasksRepository.catalog()).filter((task) => task.period === "achievement" && task.category !== null && !task.taskId.startsWith("it_"));
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

  describe("каталог после миграции", () => {
    it("ровно 65 достижений (48 и 17 про боссов, элит, сундуки, кристаллы и эволюции), id уникальны, у каждого категория из четырёх и престиж больше нуля", () => {
      expect(catalog.length).toBe(65);
      expect(new Set(catalog.map((task) => task.taskId)).size).toBe(catalog.length);
      for (const task of catalog) {
        expect(["combat", "collection", "mastery", "friends"], task.taskId).toContain(task.category);
        expect(task.prestige, task.taskId).toBeGreaterThan(0);
        expect(task.active, task.taskId).toBe(true);
        expect(task.period, task.taskId).toBe("achievement");
      }
      for (const category of ["combat", "collection", "mastery", "friends"]) expect(catalog.some((task) => task.category === category), category).toBe(true);
    });

    it("ни одна посеянная строка не потерялась при чтении: вид, фильтр и поля известны серверу", async () => {
      const [row] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM task_def WHERE category IS NOT NULL AND task_id NOT LIKE 'it\_%'`;
      expect(row?.count).toBe(catalog.length);
      for (const task of catalog) expect(TASK_KIND_IDS, task.taskId).toContain(task.kind);
      const weaponIds = new Set(WEAPONS.map((weapon) => weapon.id));
      for (const task of catalog.filter((candidate) => candidate.kind === "weapon_runs")) expect(weaponIds.has(task.filter?.weapon ?? ""), task.taskId).toBe(true);
      for (const task of catalog.filter((candidate) => candidate.kind === "element_runs")) expect(ELEMENTS as readonly string[], task.taskId).toContain(task.filter?.element);
    });

    it("ступени каждой лестницы идут 1…n без пропусков, цель и престиж растут", () => {
      const ladders = new Map<string, TaskDef[]>();
      for (const task of catalog) {
        if (task.ladder === null) {
          expect(task.rung, task.taskId).toBeNull();
          continue;
        }
        ladders.set(task.ladder, [...(ladders.get(task.ladder) ?? []), task]);
      }
      expect(ladders.size).toBeGreaterThanOrEqual(8);
      for (const [ladder, rungs] of ladders) {
        const sorted = [...rungs].sort((a, b) => (a.rung ?? 0) - (b.rung ?? 0));
        expect(
          sorted.map((task) => task.rung),
          ladder,
        ).toEqual(sorted.map((_task, index) => index + 1));
        expect(new Set(sorted.map((task) => task.kind)).size, `${ladder}: один вид на лестницу`).toBe(1);
        expect(new Set(sorted.map((task) => task.category)).size, `${ladder}: одна категория на лестницу`).toBe(1);
        for (let index = 1; index < sorted.length; index++) {
          expect(sorted[index]?.target ?? 0, `${ladder}: цель ступени ${String(index + 1)}`).toBeGreaterThan(sorted[index - 1]?.target ?? 0);
          expect(sorted[index]?.prestige ?? 0, `${ladder}: престиж ступени ${String(index + 1)}`).toBeGreaterThan(sorted[index - 1]?.prestige ?? 0);
        }
      }
    });

    it("скрытых не меньше трёх, у каждого подсказка", () => {
      const hidden = catalog.filter((task) => task.hidden);
      expect(hidden.length).toBeGreaterThanOrEqual(3);
      for (const task of hidden) {
        expect(task.hint, task.taskId).not.toBeNull();
        expect(task.hint?.length ?? 0, task.taskId).toBeGreaterThan(5);
        expect(task.category, task.taskId).toBe("mastery");
      }
    });

    it("девять старых сохранили цели и награды и получили названия", () => {
      for (const [taskId, expected] of Object.entries(OLD)) {
        const task = catalog.find((candidate) => candidate.taskId === taskId);
        expect(task, taskId).toMatchObject({ target: expected.target, coins: expected.coins, gems: expected.gems, shards: 0, title: expected.title, active: true });
      }
    });

    it("новые награждаются монетами, без самоцветов и осколков; вместе со старыми они не упираются в суточный потолок", () => {
      const added = catalog.filter((task) => OLD[task.taskId] === undefined);
      expect(added.length).toBe(56);
      for (const task of added) expect(task, task.taskId).toMatchObject({ gems: 0, shards: 0, passPoints: 0 });
      for (const task of added) expect(task.coins, task.taskId).toBeGreaterThan(0);
      expect(catalog.reduce((sum, task) => sum + task.coins, 0)).toBeLessThanOrEqual(20_000);
      expect(catalog.reduce((sum, task) => sum + task.gems, 0)).toBeLessThanOrEqual(200);
    });

    it("семнадцать новых достижений (T-0126): лестницы, цели, названия, награда и престиж по лестнице", () => {
      // [id, лестница, ступень, вид, цель, название, категория, монеты, престиж]
      const expected: [string, string, number, string, number, string, string, number, number][] = [
        ["ach_elite_1", "elite", 1, "elite_kills", 1, "Первая элита", "combat", 100, 5],
        ["ach_elite_10", "elite", 2, "elite_kills", 10, "Охотник на элит", "combat", 200, 10],
        ["ach_elite_50", "elite", 3, "elite_kills", 50, "Гроза элит", "combat", 400, 20],
        ["ach_elite_200", "elite", 4, "elite_kills", 200, "Погибель элит", "combat", 800, 40],
        ["ach_boss_1", "boss", 1, "boss_kills", 1, "Первый босс", "combat", 200, 10],
        ["ach_boss_5", "boss", 2, "boss_kills", 5, "Истребитель боссов", "combat", 400, 20],
        ["ach_boss_25", "boss", 3, "boss_kills", 25, "Гроза боссов", "combat", 800, 40],
        ["ach_chest_1", "chest", 1, "chests_opened", 1, "Первая находка", "collection", 100, 5],
        ["ach_chest_10", "chest", 2, "chests_opened", 10, "Кладоискатель", "collection", 200, 10],
        ["ach_chest_50", "chest", 3, "chests_opened", 50, "Хозяин сундуков", "collection", 400, 20],
        ["ach_chest_200", "chest", 4, "chests_opened", 200, "Король сундуков", "collection", 800, 40],
        ["ach_crystal_1k", "crystal", 1, "crystals_collected", 1_000, "Горсть кристаллов", "collection", 100, 5],
        ["ach_crystal_10k", "crystal", 2, "crystals_collected", 10_000, "Мешок кристаллов", "collection", 200, 10],
        ["ach_crystal_100k", "crystal", 3, "crystals_collected", 100_000, "Кристальная гора", "collection", 400, 20],
        ["ach_evolution_1", "evolution", 1, "evolution_runs", 1, "Превращение", "collection", 200, 10],
        ["ach_evolution_5", "evolution", 2, "evolution_runs", 5, "Эволюционист", "collection", 400, 20],
        ["ach_evolution_25", "evolution", 3, "evolution_runs", 25, "Мастер превращений", "collection", 800, 40],
      ];
      expect(expected.length).toBe(17);
      for (const [taskId, ladder, rung, kind, target, title, category, coins, prestige] of expected) {
        const task = catalog.find((candidate) => candidate.taskId === taskId);
        expect(task, taskId).toMatchObject({ period: "achievement", ladder, rung, kind, target, title, category, coins, prestige, gems: 0, shards: 0, passPoints: 0, hidden: false, hint: null, filter: null, tier: null, active: true });
      }
    });

    it("единая сложность (Р126): цели на сложность — только «Сложная»", () => {
      for (const task of catalog.filter((candidate) => candidate.kind === "difficulty_survive_sec" || candidate.kind === "difficulty_runs")) {
        expect(task.filter, task.taskId).toEqual({ difficulty: "hard" });
      }
    });

    it("база не принимает категорию вне четырёх, лестницу без ступени, скрытое без подсказки и поля у ежедневного", async () => {
      const taskId = `it_chk_${STAMP}`;
      const insert = (patch: { period?: string; category?: string | null; ladder?: string | null; rung?: number | null; hidden?: boolean; hint?: string | null; prestige?: number }) =>
        prisma.$executeRaw`
          INSERT INTO task_def (task_id, period, kind, target, coins, category, ladder, rung, hidden, hint, prestige, active, created_at, updated_at)
          VALUES (${taskId}, ${patch.period ?? "achievement"}::"TaskPeriod", 'runs', 1, 10, ${patch.category ?? null}, ${patch.ladder ?? null}, ${patch.rung ?? null},
                  ${patch.hidden ?? false}, ${patch.hint ?? null}, ${patch.prestige ?? 0}, false, now(), now())`;
      try {
        await expect(insert({ category: "pvp" })).rejects.toThrow();
        await expect(insert({ category: "combat", ladder: "kills" })).rejects.toThrow();
        await expect(insert({ category: "combat", rung: 1 })).rejects.toThrow();
        await expect(insert({ category: "combat", ladder: "kills", rung: 0 })).rejects.toThrow();
        await expect(insert({ category: "combat", hidden: true })).rejects.toThrow();
        await expect(insert({ category: "combat", prestige: -1 })).rejects.toThrow();
        await expect(insert({ period: "daily", category: "combat" })).rejects.toThrow();
        await expect(insert({ period: "daily", prestige: 5 })).rejects.toThrow();
        await expect(insert({ period: "weekly", hidden: true, hint: "Подсказка" })).rejects.toThrow();
        await expect(insert({ period: "daily", hint: "Подсказка" })).rejects.toThrow();
        // допустимое проходит: подсказка без скрытого, скрытое с подсказкой, лестница со ступенью
        await expect(insert({ category: "combat", ladder: "kills", rung: 1, hint: "Подсказка", prestige: 5 })).resolves.toBe(1);
        await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${taskId}`;
        await expect(insert({ category: "mastery", hidden: true, hint: "Подсказка", prestige: 40 })).resolves.toBe(1);
        await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${taskId}`;
        await expect(insert({ period: "daily" })).resolves.toBe(1);
      } finally {
        await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${taskId}`;
      }
    });
  });

  describe("витрина и скрытые", () => {
    it("закрытое скрытое отдаёт только id, категорию, признак, done: false и подсказку; открытое — полностью", async () => {
      const me = await player();
      const view = await service.view(me, NOON);
      const closed = itemOf(view, "ach_hidden_marathon");
      expect(closed).toEqual({ id: "ach_hidden_marathon", category: "mastery", hidden: true, done: false, hint: "Продержаться очень, очень долго" });
      for (const secret of ["title", "kind", "target", "reward", "value", "prestige", "percent"]) expect(closed, secret).not.toHaveProperty(secret);
      expect(JSON.stringify(view)).not.toContain("Марафонец");
      // все три скрытых закрыты и называют себя только подсказкой
      expect(view.items.filter((item) => item.hidden && !item.done).map((item) => item.id).sort()).toEqual(["ach_hidden_hard_7", "ach_hidden_level_60", "ach_hidden_marathon"]);

      await tasks.onRun(recorded(me.accountId, { survivalSec: 1900, level: 22 }));
      const open = itemOf(await service.view(me, NOON), "ach_hidden_marathon");
      expect(open).toMatchObject({
        id: "ach_hidden_marathon",
        category: "mastery",
        hidden: true,
        kind: "best_survival_sec",
        title: "Марафонец",
        hint: "Продержаться очень, очень долго",
        target: 1800,
        value: 1800,
        done: true,
        claimed: false,
        reward: { coins: 500, gems: 0, shards: 0 },
        prestige: 40,
      });
    });

    it("список заданий закрытых скрытых не возвращает, открытые — как обычные", async () => {
      const me = await player();
      const before = await tasks.view(me, NOON);
      expect(before.map((task) => task.id)).not.toContain("ach_hidden_marathon");
      expect(before.map((task) => task.id)).toContain("ach_kills_100");
      expect(JSON.stringify(before)).not.toContain("Марафонец");
      expect(JSON.stringify(before)).not.toContain("Продержаться очень");

      // на «Лёгкой» — цель «Выстоявшего» на «Сложной» этим забегом не открывается
      await tasks.onRun(recorded(me.accountId, { survivalSec: 1900, difficulty: "easy" }));
      const after = await tasks.view(me, NOON);
      expect(after.find((task) => task.id === "ach_hidden_marathon")).toMatchObject({ title: "Марафонец", done: true, hidden: true, achievementCategory: "mastery", prestige: 40 });
      // других скрытых это не открыло
      expect(after.map((task) => task.id)).not.toContain("ach_hidden_hard_7");
    });

    it("витрина — это достижения: ежедневные, недельные и партнёрские цели в неё не попадают; порядок как в панели", async () => {
      const me = await player();
      const view = await service.view(me, NOON);
      expect(view.items.length).toBe(catalog.length);
      expect(idsOf(view).every((id) => catalog.some((task) => task.taskId === id))).toBe(true);
      const sorts = idsOf(view).map((id) => catalog.find((task) => task.taskId === id)?.sort ?? 0);
      expect(sorts).toEqual([...sorts].sort((a, b) => a - b));
      expect(view).toMatchObject({ prestige: 0, favorites: [] });
    });
  });

  describe("престиж", () => {
    it("сумма по выполненным; невыполненные не считаются", async () => {
      const me = await player();
      await complete(me.accountId, "ach_friends_1", "ach_friends_5", "ach_hidden_marathon");
      // прогресс без выполнения
      await prisma.$executeRaw`
        INSERT INTO task_progress (account_id, task_id, period_start, value, target, updated_at)
        VALUES (${me.accountId}::uuid, 'ach_kills_100k', DATE '2000-01-01', 500, 100000, now())`;
      const expected = ["ach_friends_1", "ach_friends_5", "ach_hidden_marathon"].reduce((sum, id) => sum + (catalog.find((task) => task.taskId === id)?.prestige ?? 0), 0);
      expect(expected).toBe(5 + 10 + 40);
      expect((await service.view(me, NOON)).prestige).toBe(expected);
      expect((await service.summary(me.accountId)).prestige).toBe(expected);
    });

    it("выключенное в панели достижение считается: престиж не пропадает", async () => {
      const me = await player();
      const off = `it_ach_off_${STAMP}`;
      try {
        await prisma.$executeRaw`
          INSERT INTO task_def (task_id, period, kind, target, coins, category, prestige, active, sort, created_at, updated_at)
          VALUES (${off}, 'achievement', 'runs', 1, 10, 'combat', 7, false, 9000, now(), now())`;
        await complete(me.accountId, off, "ach_friends_1");
        expect((await service.view(me, NOON)).prestige).toBe(5 + 7);
        // и в витрине выключенное не видно
        expect(idsOf(await service.view(me, NOON))).not.toContain(off);
      } finally {
        await prisma.$executeRaw`DELETE FROM task_progress WHERE task_id = ${off}`;
        await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${off}`;
      }
    });

    it("prestigeOf: три аккаунта одним вызовом, у не имеющего достижений — ноль, повтор id не удваивает", async () => {
      const [a, b, c] = [await account(), await account(), await account()];
      await complete(a, "ach_friends_1", "ach_friends_5");
      await complete(b, "ach_hidden_marathon");
      const result = await service.prestigeOf([a, b, c, a]);
      expect(result.get(a)).toBe(15);
      expect(result.get(b)).toBe(40);
      expect(result.get(c)).toBe(0);
      expect(result.size).toBe(3);
      expect((await service.prestigeOf([])).size).toBe(0);
    });
  });

  describe("состояние: друзья и уровень аккаунта", () => {
    it("пять друзей — выполнены «Не один» и «Свои люди», остальные нет; друзей стало меньше — прогресс не убывает", async () => {
      const me = await player();
      const friends = await befriend(me.accountId, 5);
      const view = await service.view(me, NOON);
      expect(itemOf(view, "ach_friends_1")).toMatchObject({ done: true, value: 1 });
      expect(itemOf(view, "ach_friends_5")).toMatchObject({ done: true, value: 5 });
      expect(itemOf(view, "ach_friends_10")).toMatchObject({ done: false, value: 5 });
      expect(itemOf(view, "ach_friends_25")).toMatchObject({ done: false, value: 5 });
      expect(view.prestige).toBe(15);

      await prisma.$executeRaw`DELETE FROM friendship WHERE account_a = ANY(${[...friends.slice(0, 3), me.accountId]}::uuid[]) AND account_b = ANY(${[...friends.slice(0, 3), me.accountId]}::uuid[])`;
      const fewer = await service.view(me, NOON);
      expect(itemOf(fewer, "ach_friends_5")).toMatchObject({ done: true, value: 5 });
      expect(itemOf(fewer, "ach_friends_10")).toMatchObject({ done: false, value: 5 });
    });

    it("уровень аккаунта 12 — выполнено «Десятый уровень», а «Четверть сотни» нет", async () => {
      const me = await player();
      await prisma.$executeRaw`INSERT INTO account_progress (account_id, xp, level, updated_at) VALUES (${me.accountId}::uuid, 0, 12, now())`;
      const view = await service.view(me, NOON);
      expect(itemOf(view, "ach_account_10")).toMatchObject({ done: true, value: 10 });
      expect(itemOf(view, "ach_account_25")).toMatchObject({ done: false, value: 12 });
      // без записи прогресса аккаунт — первого уровня, и это не ошибка
      const fresh = await player();
      expect(itemOf(await service.view(fresh, NOON), "ach_account_10")).toMatchObject({ done: false, value: 1 });
    });

    it("забег состояний не двигает: игрок с забегом, но без друзей, «Не один» не получает", async () => {
      const me = await player();
      await tasks.onRun(recorded(me.accountId));
      const [row] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM task_progress WHERE account_id = ${me.accountId}::uuid AND task_id IN ('ach_friends_1', 'ach_account_10')`;
      expect(row?.count).toBe(0);
    });

    it("сбой чтения друзей витрину не роняет: прогресс остаётся как был", async () => {
      const me = await player();
      const broken = new AchievementsService(
        tasks,
        repository,
        {
          friendCount: async () => {
            throw new Error("база друзей недоступна");
          },
        },
        new ProgressService(new PrismaProgressRepository(prisma)),
        settings,
      );
      const view = await broken.view(me, NOON);
      expect(view.items.length).toBe(catalog.length);
    });
  });

  describe("избранное", () => {
    async function unlocked(count: number): Promise<{ me: AccountRef; ids: string[] }> {
      const me = await player();
      const ids = ["ach_friends_1", "ach_friends_5", "ach_kills_100", "ach_runs_1"].slice(0, count);
      await complete(me.accountId, ...ids);
      return { me, ids };
    }

    it("три выполненных сохраняются в порядке массива, смена порядка меняет слоты", async () => {
      const { me, ids } = await unlocked(3);
      expect(await service.setFavorites(me.accountId, ids)).toEqual({ favorites: ids });
      expect((await service.view(me, NOON)).favorites).toEqual(ids);
      const reversed = [...ids].reverse();
      await service.setFavorites(me.accountId, reversed);
      expect((await service.summary(me.accountId)).favorites.map((favorite) => favorite.id)).toEqual(reversed);
      const slots = await prisma.$queryRaw<{ slot: number; task_id: string }[]>`SELECT slot, task_id FROM achievement_favorite WHERE account_id = ${me.accountId}::uuid ORDER BY slot`;
      expect(slots).toEqual(reversed.map((id, index) => ({ slot: index + 1, task_id: id })));
    });

    it("сводка для профиля: id, название и категория; без списка достижений", async () => {
      const { me, ids } = await unlocked(2);
      await service.setFavorites(me.accountId, ids);
      const summary = await service.summary(me.accountId);
      expect(summary).toEqual({
        prestige: 15,
        favorites: [
          { id: "ach_friends_1", title: "Не один", category: "friends" },
          { id: "ach_friends_5", title: "Свои люди", category: "friends" },
        ],
      });
      expect(Object.keys(summary).sort()).toEqual(["favorites", "prestige"]);
    });

    it("невыполненное и несуществующее — achievement_not_unlocked, и прежнее избранное не меняется", async () => {
      const { me, ids } = await unlocked(2);
      await service.setFavorites(me.accountId, ids);
      await expect(service.setFavorites(me.accountId, [...ids, "ach_kills_100k"])).rejects.toBeInstanceOf(AchievementNotUnlockedError);
      await expect(service.setFavorites(me.accountId, ["ach_net_takogo"])).rejects.toBeInstanceOf(AchievementNotUnlockedError);
      expect((await service.summary(me.accountId)).favorites.map((favorite) => favorite.id)).toEqual(ids);
      expect(new AchievementNotUnlockedError()).toMatchObject({ code: "achievement_not_unlocked", status: 409 });
    });

    it("чужое избранное не меняется; чужое выполненное в своё не поставить", async () => {
      const mine = await unlocked(2);
      const theirs = await unlocked(2);
      await service.setFavorites(theirs.me.accountId, theirs.ids);
      await service.setFavorites(mine.me.accountId, [mine.ids[1] ?? ""]);
      expect((await service.summary(theirs.me.accountId)).favorites.map((favorite) => favorite.id)).toEqual(theirs.ids);

      const stranger = await player();
      await expect(service.setFavorites(stranger.accountId, ["ach_runs_1"])).rejects.toBeInstanceOf(AchievementNotUnlockedError);
    });

    it("повторный запрос — тот же результат; пустой список очищает", async () => {
      const { me, ids } = await unlocked(3);
      const first = await service.setFavorites(me.accountId, ids);
      const second = await service.setFavorites(me.accountId, ids);
      expect(second).toEqual(first);
      const [rows] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM achievement_favorite WHERE account_id = ${me.accountId}::uuid`;
      expect(rows?.count).toBe(3);
      expect(await service.setFavorites(me.accountId, [])).toEqual({ favorites: [] });
      expect((await service.summary(me.accountId)).favorites).toEqual([]);
    });

    it("два одинаковых запроса разом не ломаются о первичный и уникальный ключи", async () => {
      const { me, ids } = await unlocked(3);
      const results = await Promise.all([service.setFavorites(me.accountId, ids), service.setFavorites(me.accountId, [...ids].reverse()), service.setFavorites(me.accountId, ids)]);
      for (const result of results) expect(result.favorites).toHaveLength(3);
      const rows = await prisma.$queryRaw<{ slot: number }[]>`SELECT slot FROM achievement_favorite WHERE account_id = ${me.accountId}::uuid ORDER BY slot`;
      expect(rows.map((row) => row.slot)).toEqual([1, 2, 3]);
    });

    it("база держит потолок: четвёртого слота, занятого слота и повтора достижения нет", async () => {
      const { me, ids } = await unlocked(2);
      await expect(prisma.$executeRaw`INSERT INTO achievement_favorite (account_id, slot, task_id) VALUES (${me.accountId}::uuid, 4, ${ids[0] ?? ""})`).rejects.toThrow();
      await service.setFavorites(me.accountId, ids);
      // слот 1 занят
      await expect(prisma.$executeRaw`INSERT INTO achievement_favorite (account_id, slot, task_id) VALUES (${me.accountId}::uuid, 1, 'ach_runs_1')`).rejects.toThrow();
      // слот 3 свободен, но достижение уже в избранном
      await expect(prisma.$executeRaw`INSERT INTO achievement_favorite (account_id, slot, task_id) VALUES (${me.accountId}::uuid, 3, ${ids[0] ?? ""})`).rejects.toThrow();
    });

    it("удаление аккаунта убирает его избранное", async () => {
      const { me, ids } = await unlocked(3);
      await service.setFavorites(me.accountId, ids);
      await prisma.$executeRaw`DELETE FROM account WHERE account_id = ${me.accountId}::uuid`;
      const [rows] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM achievement_favorite WHERE account_id = ${me.accountId}::uuid`;
      expect(rows?.count).toBe(0);
    });
  });

  describe("редкость «есть у N%»", () => {
    const LADDER_TOP = "ach_friends_25";
    const clock = { next: Date.now() + 24 * HOUR };
    /** Каждый вызов позже предыдущего больше чем на период: пересчёт всегда назрел. */
    const later = (): Date => new Date((clock.next += 7 * HOUR));
    const refreshing = panelSettings();

    const newJob = (source: AchievementsRepository = repository): AchievementRarityJob => new AchievementRarityJob(config, source, refreshing, redis);

    beforeAll(async () => {
      // База живёт дольше одного прогона: часы теста начинаются после последнего пересчёта.
      const last = await repository.rarityComputedAt();
      clock.next = Math.max(Date.now(), last?.getTime() ?? 0) + 24 * HOUR;
    });

    beforeEach(async () => {
      await redis.del(RARITY_LOCK_KEY);
      // Достижение, которого нет у других файлов: числа держателей считаются точно.
      await prisma.$executeRaw`DELETE FROM task_progress WHERE task_id = ${LADDER_TOP}`;
    });

    /** Население как его считает спецификация: игроки хотя бы с одним записанным забегом. */
    async function population(): Promise<number> {
      const [row] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM account a WHERE EXISTS (SELECT 1 FROM run r WHERE r.account_id = a.account_id AND r.status = 'finished')`;
      return row?.count ?? 0;
    }

    it("игрок без забегов, но с достижением, не входит ни в числитель, ни в знаменатель", async () => {
      const withRun = await account();
      const noRun = await account();
      const bystander = await account();
      await finishedRun(withRun);
      await finishedRun(bystander);
      await complete(withRun, LADDER_TOP);
      await complete(noRun, LADDER_TOP);

      const low = await population();
      const report = await newJob().tick(later());
      const high = await population();

      expect(report).not.toBeNull();
      const rarity = await repository.rarity();
      expect(rarity.rows.get(LADDER_TOP)?.holders).toBe(1);
      const counted = rarity.rows.get(LADDER_TOP)?.population ?? 0;
      expect(counted).toBeGreaterThanOrEqual(low);
      expect(counted).toBeLessThanOrEqual(high);
      expect(counted).toBeGreaterThanOrEqual(2);
      // знаменатель тот же у каждой строки одного прохода
      expect(new Set([...rarity.rows.values()].map((row) => row.population)).size).toBe(1);
      expect(report?.population).toBe(counted);
      expect(report?.rows).toBe(rarity.rows.size);
    });

    it("в таблице по строке на каждое посеянное достижение; держателей не больше населения", async () => {
      await newJob().tick(later());
      const rarity = await repository.rarity();
      for (const task of catalog) expect(rarity.rows.has(task.taskId), task.taskId).toBe(true);
      for (const [taskId, row] of rarity.rows) {
        expect(row.holders, taskId).toBeGreaterThanOrEqual(0);
        expect(row.holders, taskId).toBeLessThanOrEqual(row.population);
      }
    });

    it("два одновременных tick() двух реплик: пересчёт делает один, второй возвращает null", async () => {
      const [first, second] = await Promise.all([newJob().tick(later()), newJob().tick(later())]);
      expect([first, second].filter((report) => report !== null)).toHaveLength(1);
      expect(await redis.get(RARITY_LOCK_KEY)).toBeNull();
    });

    it("лок у другой реплики — пересчёта нет и таблица не тронута", async () => {
      await newJob().tick(later());
      const before = await repository.rarityComputedAt();
      await redis.set(RARITY_LOCK_KEY, "чужой-токен", "PX", 60_000, "NX");
      expect(await newJob().tick(later())).toBeNull();
      expect(await repository.rarityComputedAt()).toEqual(before);
      // чужой лок не снят: снимает только владелец токена
      expect(await redis.get(RARITY_LOCK_KEY)).toBe("чужой-токен");
    });

    it("computed_at обновляется; пока период не вышел — тик ничего не делает", async () => {
      const job = newJob();
      const at = later();
      expect(await job.tick(at)).not.toBeNull();
      expect(await repository.rarityComputedAt()).toEqual(at);
      // через пять часов при периоде 360 минут — не пора
      expect(await job.tick(new Date(at.getTime() + 5 * HOUR))).toBeNull();
      expect(await repository.rarityComputedAt()).toEqual(at);
      // через шесть — пора
      const again = new Date(at.getTime() + 6 * HOUR);
      expect(await job.tick(again)).not.toBeNull();
      expect(await repository.rarityComputedAt()).toEqual(again);
      expect(await redis.get(RARITY_LOCK_KEY)).toBeNull();
    });

    it("период пересчёта берётся из настройки панели", async () => {
      const fast = panelSettings({ [SETTINGS.achievementsRarityRefreshMin.key]: 10 });
      const job = new AchievementRarityJob(config, repository, fast, redis);
      const at = later();
      expect(await job.tick(at)).not.toBeNull();
      expect(await job.tick(new Date(at.getTime() + 5 * 60_000))).toBeNull();
      expect(await job.tick(new Date(at.getTime() + 10 * 60_000))).not.toBeNull();
    });

    it("сбой пересчёта: старые числа остаются, лок снят, тик возвращает null", async () => {
      await newJob().tick(later());
      const before = await repository.rarity();
      const broken = Object.create(repository) as AchievementsRepository;
      broken.recomputeRarity = async () => {
        throw new Error("запрос не уложился в время");
      };
      expect(await newJob(broken).tick(later())).toBeNull();
      const after = await repository.rarity();
      expect(after.computedAt).toEqual(before.computedAt);
      expect([...after.rows.keys()].sort()).toEqual([...before.rows.keys()].sort());
      expect(await redis.get(RARITY_LOCK_KEY)).toBeNull();
    });

    it("замена таблицы одной транзакцией: число строк не прыгает, лишних нет", async () => {
      await newJob().tick(later());
      await newJob().tick(later());
      const [row] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM achievement_rarity`;
      const [expected] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM task_def WHERE period = 'achievement' AND category IS NOT NULL`;
      expect(row?.count).toBe(expected?.count);
    });

    it("при населении ниже порога — shown: false и percent: null; после снижения порога настройкой — число", async () => {
      const holder = await player();
      await finishedRun(holder.accountId);
      await complete(holder.accountId, LADDER_TOP);
      await newJob().tick(later());
      const counted = (await repository.rarity()).rows.get(LADDER_TOP)?.population ?? 0;
      expect(counted).toBeGreaterThanOrEqual(1);

      settings.set(SETTINGS.achievementsRarityMinPlayers.key, Math.min(counted + 1, 100_000));
      const hidden = await service.view(holder, NOON);
      expect(hidden.rarity).toMatchObject({ population: counted, shown: false });
      expect(hidden.rarity.computedAt).not.toBeNull();
      expect(itemOf(hidden, LADDER_TOP)).toMatchObject({ percent: null });
      expect(openOf(hidden).every((item) => item.percent === null)).toBe(true);

      settings.set(SETTINGS.achievementsRarityMinPlayers.key, 1);
      const shown = await service.view(holder, NOON);
      expect(shown.rarity).toMatchObject({ population: counted, shown: true });
      const percent = openOf(shown).find((item) => item.id === LADDER_TOP)?.percent ?? null;
      expect(percent).not.toBeNull();
      expect(percent ?? 0).toBeGreaterThan(0);
      expect(percent ?? 0).toBeLessThanOrEqual(100);
      settings.set(SETTINGS.achievementsRarityMinPlayers.key, 100);
    });

    it("пока пересчёта не было, редкости нет: население 0, процента нет", async () => {
      await prisma.$executeRaw`DELETE FROM achievement_rarity`;
      const me = await player();
      const view = await service.view(me, NOON);
      expect(view.rarity).toEqual({ population: 0, shown: false, computedAt: null });
      expect(openOf(view).every((item) => item.percent === null)).toBe(true);
      // пустая таблица — повод пересчитать
      expect(await newJob().tick(later())).not.toBeNull();
    });
  });

  describe("забор достижения", () => {
    it("монеты ложатся на баланс один раз, причина achievement_reward", async () => {
      const me = await player();
      await tasks.onRun(recorded(me.accountId));
      const before = (await wallet.balances(me.accountId)).coins;

      const first = await tasks.claim(me, "ach_runs_1", NOON);
      expect(first.claimed).toBe(true);
      expect(first.credited).toEqual({ coins: 50, gems: 0, shards: 0 });
      const second = await tasks.claim(me, "ach_runs_1", NOON);
      expect(second.claimed).toBe(false);
      expect(second.credited).toEqual({ coins: 0, gems: 0, shards: 0 });
      expect((await wallet.balances(me.accountId)).coins).toBe(before + 50);

      const entries = await prisma.$queryRaw<{ reason: string; amount: bigint }[]>`
        SELECT reason, amount FROM wallet_entry WHERE account_id = ${me.accountId}::uuid AND source = 'task:ach_runs_1'`;
      expect(entries.map((entry) => [entry.reason, Number(entry.amount)])).toEqual([["achievement_reward", 50]]);
    });

    it("боссы (T-0126): забег с одним убитым боссом выполняет «Первого босса», «Истребителя» двигает на 1; забор монет — один раз", async () => {
      const me = await player();
      const counters = { bossKills: 1, eliteKills: 0, chestsOpened: 0, rareChests: 0, crystals: 0, noHitSec: 0, noKillSec: 0, killsByElement: {} };
      await tasks.onRun(recorded(me.accountId, { counters }));
      const view = await service.view(me, NOON);
      expect(openOf(view).find((item) => item.id === "ach_boss_1")).toMatchObject({ done: true, value: 1, target: 1 });
      expect(openOf(view).find((item) => item.id === "ach_boss_5")).toMatchObject({ done: false, value: 1, target: 5 });
      // забег без счётчиков боссов не двигает
      expect(openOf(await service.view(me, NOON)).find((item) => item.id === "ach_elite_1")).toMatchObject({ done: false, value: 0 });

      const before = (await wallet.balances(me.accountId)).coins;
      expect((await tasks.claim(me, "ach_boss_1", NOON)).credited).toEqual({ coins: 200, gems: 0, shards: 0 });
      expect((await tasks.claim(me, "ach_boss_1", NOON)).credited).toEqual({ coins: 0, gems: 0, shards: 0 });
      expect((await wallet.balances(me.accountId)).coins).toBe(before + 200);
      const entries = await prisma.$queryRaw<{ reason: string; amount: bigint }[]>`
        SELECT reason, amount FROM wallet_entry WHERE account_id = ${me.accountId}::uuid AND source = 'task:ach_boss_1'`;
      expect(entries.map((entry) => [entry.reason, Number(entry.amount)])).toEqual([["achievement_reward", 200]]);
    });

    it("эволюция (T-0126): «Гадюка» в наборе выполняет «Превращение» и засчитывается за оружие «Жало»", async () => {
      const me = await player();
      await tasks.onRun(recorded(me.accountId, { weapons: [{ id: "viper", level: 1 }] }));
      const view = await service.view(me, NOON);
      expect(openOf(view).find((item) => item.id === "ach_evolution_1")).toMatchObject({ done: true, value: 1 });
      expect(openOf(view).find((item) => item.id === "ach_evolution_5")).toMatchObject({ done: false, value: 1 });
      expect(openOf(view).find((item) => item.id === "ach_weapon_sting")).toMatchObject({ done: false, value: 1 });
      expect(openOf(view).find((item) => item.id === "ach_element_poison")).toMatchObject({ done: false, value: 1 });
      // оружие без эволюции «Превращение» не двигает
      const other = await player();
      await tasks.onRun(recorded(other.accountId, { weapons: [{ id: "sting", level: 5 }] }));
      expect(openOf(await service.view(other, NOON)).find((item) => item.id === "ach_evolution_1")).toMatchObject({ done: false, value: 0 });
    });

    it("забор выполненного друзьями достижения не требует партнёрских прав, а невыполненного — «не выполнено»", async () => {
      const me = await player();
      await expect(tasks.claim(me, "ach_friends_1", NOON)).rejects.toMatchObject({ code: "task_not_done" });
      await befriend(me.accountId, 1);
      await service.view(me, NOON);
      expect((await tasks.claim(me, "ach_friends_1", NOON)).credited.coins).toBe(100);
    });
  });

  describe("по HTTP", () => {
    let app: NestFastifyApplication | null = null;

    afterEach(async () => {
      await app?.close();
      app = null;
    });

    async function boot(): Promise<void> {
      @Module({
        controllers: [AchievementsController],
        providers: [{ provide: APP_CONFIG, useValue: config }, { provide: REDIS, useValue: redis }, { provide: AchievementsService, useValue: service }, RateLimiter, AuthGuard],
      })
      class TestModule {}
      app = await createHttpApp(TestModule, { logger: false });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    }

    async function headersOf(me: AccountRef): Promise<Record<string, string>> {
      const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: me.platformUserId }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
      return { authorization: `Bearer ${token}` };
    }

    it("без токена — 401; витрина, сводка и избранное отвечают по форме из задачи", async () => {
      await boot();
      const me = await player();
      await complete(me.accountId, "ach_friends_1", "ach_kills_100");
      const headers = await headersOf(me);
      const http = app;
      if (http === null) throw new Error("приложение не запущено");

      for (const [method, url] of [["GET", "/api/v1/achievements"], ["GET", "/api/v1/achievements/summary"], ["PUT", "/api/v1/achievements/favorites"]] as const) {
        expect((await http.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
      }

      const view = await http.inject({ method: "GET", url: "/api/v1/achievements", headers });
      expect(view.statusCode).toBe(200);
      const body = view.json<{ data: AchievementsView }>().data;
      expect(Object.keys(body).sort()).toEqual(["favorites", "items", "prestige", "rarity"]);
      expect(Object.keys(body.rarity).sort()).toEqual(["computedAt", "population", "shown"]);
      expect(body.prestige).toBe(10);
      expect(body.items.length).toBe(catalog.length);

      const empty = await http.inject({ method: "GET", url: "/api/v1/achievements/summary", headers });
      expect(empty.json<{ data: unknown }>().data).toEqual({ prestige: 10, favorites: [] });

      const put = await http.inject({ method: "PUT", url: "/api/v1/achievements/favorites", headers, payload: { ids: ["ach_kills_100", "ach_friends_1"] } });
      expect(put.statusCode).toBe(200);
      expect(put.json<{ data: unknown }>().data).toEqual({ favorites: ["ach_kills_100", "ach_friends_1"] });
      const summary = await http.inject({ method: "GET", url: "/api/v1/achievements/summary", headers });
      expect(summary.json<{ data: { favorites: { id: string }[] } }>().data.favorites.map((favorite) => favorite.id)).toEqual(["ach_kills_100", "ach_friends_1"]);
    });

    it("четыре id, повтор, кривой id и тело не по схеме — 400; невыполненное — 409 с кодом", async () => {
      await boot();
      const me = await player();
      await complete(me.accountId, "ach_friends_1", "ach_friends_5", "ach_kills_100", "ach_runs_1");
      const headers = await headersOf(me);
      const http = app;
      if (http === null) throw new Error("приложение не запущено");
      const put = (payload: unknown) => http.inject({ method: "PUT", url: "/api/v1/achievements/favorites", headers, payload: payload as never });

      expect((await put({ ids: ["ach_friends_1", "ach_friends_5", "ach_kills_100", "ach_runs_1"] })).statusCode).toBe(400);
      expect((await put({ ids: ["ach_friends_1", "ach_friends_1"] })).statusCode).toBe(400);
      expect((await put({ ids: ["DROP TABLE"] })).statusCode).toBe(400);
      expect((await put({ ids: "ach_friends_1" })).statusCode).toBe(400);
      expect((await put({})).statusCode).toBe(400);

      const locked = await put({ ids: ["ach_kills_100k"] });
      expect(locked.statusCode).toBe(409);
      expect(locked.json<{ error: { code: string } }>().error.code).toBe("achievement_not_unlocked");

      // пустой список очищает
      expect((await put({ ids: ["ach_friends_1"] })).statusCode).toBe(200);
      const cleared = await put({ ids: [] });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json<{ data: unknown }>().data).toEqual({ favorites: [] });
    });
  });
});
