import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import type { AchievementsView, OpenAchievement } from "../src/modules/achievements/achievement-rules.js";
import { PrismaAchievementsRepository } from "../src/modules/achievements/achievements.repository.js";
import { AchievementsService } from "../src/modules/achievements/achievements.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { PrismaProgressRepository } from "../src/modules/progress/progress.repository.js";
import { ProgressService } from "../src/modules/progress/progress.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import type { RunCounters } from "../src/modules/runs/run-counters.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { isEmblemKind, type TaskDef } from "../src/modules/tasks/task-rules.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Достижения v2 на живых Postgres и Redis (tasks/T-0322; адреса —
 * TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них пропуск). Каталог — из
 * миграции: тест читает то, что она посеяла.
 *
 * Память этого не покажет: строки сеет миграция одним `INSERT … ON CONFLICT`, а
 * «Коллекционер» считает цель по каталогу и выполненных «Мастеров» игрока —
 * прогресс «максимум» в `task_progress` не убывает, когда цель растёт.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

/** среда, 21.10.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 9, 21, 9));
const STAMP = String(Date.now());

/** Семь «Мастеров оружия»: шесть из первой миграции и «Мастер Метеора». */
const MASTERS = ["ach_weapon_spark", "ach_weapon_knife", "ach_weapon_wardstone", "ach_weapon_hearth", "ach_weapon_storm", "ach_weapon_sting", "ach_weapon_meteor"] as const;

/** Забег с пустыми счётчиками, кроме заданных. */
function counters(patch: Partial<RunCounters> = {}): RunCounters {
  return { bossKills: 0, eliteKills: 0, chestsOpened: 0, rareChests: 0, crystals: 0, noHitSec: 0, noKillSec: 0, killsByElement: {}, ...patch };
}

/**
 * Шестнадцать новых строк: [id, вид, фильтр, цель, название, категория, лестница, ступень, престиж, монеты, знак].
 * Числа — из спецификации, геймдизайнер калибрует их в панели.
 */
type Row = [string, string, Record<string, string> | null, number, string, string, string | null, number | null, number, number, string | null];
const ELEMENT_LADDERS: [string, string, [string, string, string]][] = [
  ["fire", "fire_kills", ["Поджигатель", "Пламенный", "Огнепоклонник"]],
  ["cold", "cold_kills", ["Иней", "Мороз", "Стужа"]],
  ["lightning", "lightning_kills", ["Искрящий", "Грозовой", "Громовержец"]],
  ["poison", "poison_kills", ["Знахарь", "Ядовитый", "Отравитель"]],
];
const TARGETS = [500, 2_500, 10_000] as const;
const PRESTIGE = [5, 10, 20] as const;
const COINS = [100, 200, 400] as const;
const SUFFIX = ["500", "2500", "10k"] as const;
const NEW_ROWS: Row[] = [
  ["ach_no_hit_10", "no_hit_sec", null, 600, "Без единой царапины", "mastery", null, null, 40, 800, "legendary"],
  ["ach_pacifist", "no_kill_sec", null, 60, "Пацифист", "mastery", null, null, 10, 150, null],
  ...ELEMENT_LADDERS.flatMap(([element, ladder, names]) =>
    TARGETS.map((target, index): Row => [`ach_${element}_${SUFFIX[index] ?? ""}`, "element_kills", { element }, target, names[index] ?? "", "combat", ladder, index + 1, PRESTIGE[index] ?? 0, COINS[index] ?? 0, index === 2 ? "epic" : null]),
  ),
  ["ach_collector", "weapon_masters", null, 7, "Коллекционер", "collection", null, null, 40, 800, "epic"],
  ["ach_weapon_meteor", "weapon_runs", { weapon: "meteor" }, 5, "Мастер Метеора", "collection", null, null, 10, 150, "uncommon"],
];

describe.skipIf(!live)("достижения v2 на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let accounts: PrismaAccountRepository;
  let tasksRepository: PrismaTasksRepository;
  let tasks: TasksService;
  let service: AchievementsService;
  let catalog: TaskDef[];

  async function player() {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(940_000_000 + Math.floor(Math.random() * 15_000_000)), displayName: "Достижения v2", username: null },
      Date.now(),
    );
    return { accountId: created.accountId, platform: "telegram" as const, platformUserId: "1" };
  }

  let runNo = 0;
  function recorded(accountId: string, patch: Partial<RecordedRun> = {}): RecordedRun {
    return {
      runId: `ach2-it-${STAMP}-${String(runNo++)}`,
      accountId,
      difficulty: "hard",
      outcome: "died",
      survivalSec: 700,
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

  /** Достижения выполнены напрямую, мимо забега. */
  async function complete(accountId: string, ...taskIds: string[]): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO task_progress (account_id, task_id, period_start, value, target, completed_at, updated_at)
      SELECT ${accountId}::uuid, d.task_id, DATE '2000-01-01', d.target, d.target, ${NOON}, ${NOON}
      FROM task_def d WHERE d.task_id = ANY(${taskIds}::text[])
      ORDER BY d.sort, d.task_id
      ON CONFLICT (account_id, task_id, period_start) DO NOTHING`;
  }

  const openOf = (view: AchievementsView, id: string): OpenAchievement | undefined => view.items.find((item): item is OpenAchievement => item.id === id && "kind" in item);

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    accounts = new PrismaAccountRepository(prisma);
    tasksRepository = new PrismaTasksRepository(prisma);
    const wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    const unused = {} as never;
    tasks = new TasksService(tasksRepository, wallet, new RunsHooks(), unused, unused, unused, unused);
    const friends = new PrismaFriendsRepository(prisma);
    service = new AchievementsService(
      tasks,
      new PrismaAchievementsRepository(prisma),
      { friendCount: (accountId) => friends.count(accountId) },
      new ProgressService(new PrismaProgressRepository(prisma)),
      panelSettings(),
    );
    catalog = (await tasksRepository.catalog()).filter((task) => !task.taskId.startsWith("it_"));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("каталог после миграции", () => {
    it("шестнадцать новых строк со всеми числами спецификации, включены, не скрыты и без подсказки", () => {
      expect(NEW_ROWS.length).toBe(16);
      for (const [taskId, kind, filter, target, title, category, ladder, rung, prestige, coins, emblemTier] of NEW_ROWS) {
        const task = catalog.find((candidate) => candidate.taskId === taskId);
        expect(task, taskId).toMatchObject({
          period: "achievement",
          kind,
          filter,
          title,
          category,
          ladder,
          rung,
          prestige,
          coins,
          emblemTier,
          gems: 0,
          shards: 0,
          passPoints: 0,
          hidden: false,
          hint: null,
          tier: null,
          active: true,
        });
        // у «Коллекционера» хранимая цель не читается — число лишь стартовое
        if (kind !== "weapon_masters") expect(task?.target, taskId).toBe(target);
      }
    });

    it("знак у имени — только у трудных: «Без единой царапины», «Коллекционер», верхние ступени стихий, «Мастер Метеора» (лёгкий, как и прочие «Мастера»)", () => {
      const tiered = catalog.filter((task) => NEW_ROWS.some((row) => row[0] === task.taskId) && task.emblemTier !== null).map((task) => task.taskId);
      expect(tiered.sort()).toEqual(
        ["ach_no_hit_10", "ach_collector", "ach_weapon_meteor", "ach_fire_10k", "ach_cold_10k", "ach_lightning_10k", "ach_poison_10k"].sort(),
      );
      for (const id of ["ach_pacifist", "ach_fire_500", "ach_fire_2500", "ach_poison_500", "ach_cold_2500"]) {
        expect(catalog.find((task) => task.taskId === id)?.emblemTier, id).toBeNull();
      }
      expect(catalog.find((task) => task.taskId === "ach_no_hit_10")?.emblemTier).toBe("legendary");
      expect(catalog.find((task) => task.taskId === "ach_collector")?.emblemTier).toBe("epic");
    });

    it("порядок в списке — после последнего достижения (знаки статусов идут своим блоком и не в счёт), id не повторяются", () => {
      const old = catalog.filter((task) => !NEW_ROWS.some((row) => row[0] === task.taskId) && task.period === "achievement" && !isEmblemKind(task.kind));
      const lastOld = Math.max(...old.map((task) => task.sort));
      const sorts = NEW_ROWS.map((row) => catalog.find((task) => task.taskId === row[0])?.sort ?? -1);
      expect(Math.min(...sorts)).toBeGreaterThan(lastOld);
      expect(new Set(sorts).size).toBe(sorts.length);
    });

    it("«Душа компании»: прежняя ступень «5 друзей» сменила название, а цель, награда и знака — прежние", () => {
      const task = catalog.find((candidate) => candidate.taskId === "ach_friends_5");
      expect(task).toMatchObject({ title: "Душа компании", target: 5, coins: 200, gems: 0, prestige: 10, category: "friends", ladder: "friends", rung: 2, emblemTier: null });
      // второго достижения на «5 друзей» нет
      expect(catalog.filter((candidate) => candidate.kind === "friends" && candidate.target === 5).length).toBe(1);
    });

    it("все новые виды известны серверу, а стихии фильтров — из списка стихий", () => {
      for (const row of NEW_ROWS) expect(catalog.some((task) => task.taskId === row[0]), row[0]).toBe(true);
      for (const task of catalog.filter((candidate) => candidate.kind === "element_kills")) expect(["fire", "cold", "lightning", "poison"], task.taskId).toContain(task.filter?.element);
    });
  });

  describe("испытания", () => {
    it("забег без попаданий 600 секунд — «Без единой царапины» выполнено; 599 — нет", async () => {
      const winner = await player();
      await tasks.onRun(recorded(winner.accountId, { counters: counters({ noHitSec: 600 }) }));
      expect(openOf(await service.view(winner, NOON), "ach_no_hit_10")).toMatchObject({ done: true, value: 600, target: 600 });

      const near = await player();
      await tasks.onRun(recorded(near.accountId, { counters: counters({ noHitSec: 599 }) }));
      expect(openOf(await service.view(near, NOON), "ach_no_hit_10")).toMatchObject({ done: false, value: 599 });
    });

    it("лучший забег, а не сумма: две серии по 400 секунд «царапины» не дают", async () => {
      const me = await player();
      await tasks.onRun(recorded(me.accountId, { counters: counters({ noHitSec: 400 }) }));
      await tasks.onRun(recorded(me.accountId, { counters: counters({ noHitSec: 400 }) }));
      expect(openOf(await service.view(me, NOON), "ach_no_hit_10")).toMatchObject({ done: false, value: 400 });
    });

    it("минута без убийств — «Пацифист» выполнен; 59 секунд — нет", async () => {
      const winner = await player();
      await tasks.onRun(recorded(winner.accountId, { counters: counters({ noKillSec: 60 }) }));
      expect(openOf(await service.view(winner, NOON), "ach_pacifist")).toMatchObject({ done: true, value: 60 });

      const near = await player();
      await tasks.onRun(recorded(near.accountId, { counters: counters({ noKillSec: 59 }) }));
      expect(openOf(await service.view(near, NOON), "ach_pacifist")).toMatchObject({ done: false, value: 59 });
    });

    it("неправдоподобные счётчики (counters: null) испытания и стихийников не двигают", async () => {
      const me = await player();
      await tasks.onRun(recorded(me.accountId, { counters: null, survivalSec: 1_200, enemiesKilled: 900 }));
      const view = await service.view(me, NOON);
      for (const id of ["ach_no_hit_10", "ach_pacifist", "ach_fire_500", "ach_cold_500", "ach_lightning_500", "ach_poison_500"]) {
        expect(openOf(view, id), id).toMatchObject({ done: false, value: 0 });
      }
      // а остальные виды забег двигает как прежде
      expect(openOf(view, "ach_kills_100")).toMatchObject({ done: true });
    });
  });

  describe("стихийники", () => {
    it("три забега по 200 убийств огнём — ступень 500 выполнена, 2 500 — нет; холод не двинулся", async () => {
      const me = await player();
      for (let index = 0; index < 3; index++) await tasks.onRun(recorded(me.accountId, { counters: counters({ killsByElement: { fire: 200 } }) }));
      const view = await service.view(me, NOON);
      expect(openOf(view, "ach_fire_500")).toMatchObject({ done: true, value: 500, target: 500 });
      expect(openOf(view, "ach_fire_2500")).toMatchObject({ done: false, value: 600, target: 2_500 });
      expect(openOf(view, "ach_fire_10k")).toMatchObject({ done: false, value: 600 });
      expect(openOf(view, "ach_cold_500")).toMatchObject({ done: false, value: 0 });
    });

    it("одним забегом разные стихии копятся каждая в своей лестнице", async () => {
      const me = await player();
      await tasks.onRun(recorded(me.accountId, { counters: counters({ killsByElement: { fire: 120, cold: 80, lightning: 30, poison: 10 } }) }));
      const view = await service.view(me, NOON);
      expect(openOf(view, "ach_fire_500")?.value).toBe(120);
      expect(openOf(view, "ach_cold_500")?.value).toBe(80);
      expect(openOf(view, "ach_lightning_500")?.value).toBe(30);
      expect(openOf(view, "ach_poison_500")?.value).toBe(10);
    });
  });

  describe("«Коллекционер»", () => {
    it("шесть «Мастеров» из семи — не выполнен, цель семь; седьмой — выполнен", async () => {
      const me = await player();
      await complete(me.accountId, ...MASTERS.slice(0, 6));
      const six = await service.view(me, NOON);
      expect(openOf(six, "ach_collector")).toMatchObject({ done: false, value: 6, target: 7 });

      await complete(me.accountId, MASTERS[6]);
      const seven = await service.view(me, NOON);
      expect(openOf(seven, "ach_collector")).toMatchObject({ done: true, value: 7, target: 7 });
    });

    it("хранимая цель строки не читается: в каталоге хоть 1, хоть 99 — игрок видит число «Мастеров»", async () => {
      const original = catalog.find((task) => task.taskId === "ach_collector")?.target ?? 7;
      try {
        await prisma.$executeRaw`UPDATE task_def SET target = 99 WHERE task_id = 'ach_collector'`;
        tasks.forgetCatalog();
        const me = await player();
        expect(openOf(await service.view(me, NOON), "ach_collector")).toMatchObject({ done: false, value: 0, target: 7 });
      } finally {
        await prisma.$executeRaw`UPDATE task_def SET target = ${original} WHERE task_id = 'ach_collector'`;
        tasks.forgetCatalog();
      }
    });

    it("включили восьмого «Мастера» — цель восемь, а «Коллекционер» остаётся выполненным", async () => {
      const me = await player();
      await complete(me.accountId, ...MASTERS);
      expect(openOf(await service.view(me, NOON), "ach_collector")).toMatchObject({ done: true, target: 7 });

      const eighth = `it_master_${STAMP}`;
      try {
        await prisma.$executeRaw`
          INSERT INTO task_def (task_id, period, kind, filter, target, title, coins, category, prestige, sort, active, created_at, updated_at)
          VALUES (${eighth}, 'achievement'::"TaskPeriod", 'weapon_runs', '{"weapon": "spark"}'::jsonb, 5, 'Мастер для теста', 10, 'collection', 5, 9000, true, now(), now())`;
        tasks.forgetCatalog();
        const view = await service.view(me, NOON);
        expect(openOf(view, "ach_collector")).toMatchObject({ done: true, target: 8 });
        // выполненное остаётся выполненным: время выполнения в базе не снято
        const [row] = await prisma.$queryRaw<{ done: boolean }[]>`
          SELECT completed_at IS NOT NULL AS done FROM task_progress WHERE account_id = ${me.accountId}::uuid AND task_id = 'ach_collector'`;
        expect(row?.done).toBe(true);

        // новый игрок с теми же семью «Мастерами» уже не выполнил — цель теперь восемь
        const fresh = await player();
        await complete(fresh.accountId, ...MASTERS);
        expect(openOf(await service.view(fresh, NOON), "ach_collector")).toMatchObject({ done: false, value: 7, target: 8 });
      } finally {
        await prisma.$executeRaw`DELETE FROM task_progress WHERE task_id = ${eighth}`;
        await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${eighth}`;
        tasks.forgetCatalog();
      }
    });

    it("после записанного забега: пятый забег с «Метеором» делает седьмого «Мастера» — «Коллекционер» выполнен без открытия витрины", async () => {
      const me = await player();
      await complete(me.accountId, ...MASTERS.slice(0, 6));
      for (let index = 0; index < 5; index++) await tasks.onRun(recorded(me.accountId, { weapons: [{ id: "meteor", level: 2 }] }));
      const rows = await tasks.progressRows(me.accountId, NOON);
      expect(rows.find((row) => row.taskId === "ach_weapon_meteor")).toMatchObject({ done: true });
      expect(rows.find((row) => row.taskId === "ach_collector")).toMatchObject({ done: true, value: 7 });
    });

    it("«Мастер Метеора»: эволюция «Огненный дождь» считается оружием «Метеор»", async () => {
      const me = await player();
      for (let index = 0; index < 5; index++) await tasks.onRun(recorded(me.accountId, { weapons: [{ id: "fire_rain", level: 1 }] }));
      expect(openOf(await service.view(me, NOON), "ach_weapon_meteor")).toMatchObject({ done: true, value: 5 });
    });

    it("«Коллекционера» нет в видах забега: забег с одним «Мастером» двигает его, только когда «Мастер» выполнен", async () => {
      const me = await player();
      await tasks.onRun(recorded(me.accountId, { weapons: [{ id: "meteor", level: 2 }] }));
      // «Мастер Метеора» ещё 1 из 5 — «Коллекционеру» считать нечего
      const rows = await tasks.progressRows(me.accountId, NOON);
      expect(rows.find((row) => row.taskId === "ach_collector")).toBeUndefined();
    });
  });
});
