import { randomBytes, randomUUID } from "node:crypto";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { createPrisma } from "../src/infra/database.js";
import { REDIS, closeRedis, createRedis } from "../src/infra/redis.js";
import { AchievementNotUnlockedError } from "../src/modules/achievements/achievement-errors.js";
import { PrismaAchievementsRepository } from "../src/modules/achievements/achievements.repository.js";
import { AchievementsService } from "../src/modules/achievements/achievements.service.js";
import { EmblemNotFoundError, EmblemNotHeldError } from "../src/modules/achievements/emblem-errors.js";
import { HIDDEN_EMBLEM_TITLE, type EmblemsView } from "../src/modules/achievements/emblem-rules.js";
import { EmblemsController } from "../src/modules/achievements/emblems.controller.js";
import { PrismaEmblemsRepository } from "../src/modules/achievements/emblems.repository.js";
import { EmblemsService } from "../src/modules/achievements/emblems.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PrismaProgressRepository } from "../src/modules/progress/progress.repository.js";
import { ProgressService } from "../src/modules/progress/progress.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { TaskNotFoundError, TaskShapeLockedError } from "../src/modules/tasks/tasks-errors.js";
import type { TaskDef } from "../src/modules/tasks/task-rules.js";
import { PrismaTasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { TasksService } from "../src/modules/tasks/tasks.service.js";
import { PrismaVipRepository } from "../src/modules/vip/vip.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Знаки у имени на живых Postgres и Redis (tasks/T-0235, docs/35-stage4-plan.md
 * Р149; адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них пропуск).
 * Каталог — из миграции: тест читает то, что она посеяла.
 *
 * Память этого не покажет: знак на список аккаунтов собирается четырьмя
 * запросами независимо от длины списка, VIP и сезонные знаки считаются по
 * таблицам других модулей, а выбор знака держит внешний ключ на каталог.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const DAY = 86_400_000;
const STAMP = String(Date.now());

/** 24 отобранных достижения и редкость их знака — таблица из задачи. */
const MERIT_TIERS: Readonly<Record<string, string>> = {
  ach_kills_100k: "legendary",
  ach_time_100h: "legendary",
  ach_account_50: "legendary",
  ach_xp_500k: "epic",
  ach_survive_20: "epic",
  ach_level_40: "epic",
  ach_runs_200: "epic",
  ach_hard_5: "epic",
  ach_friends_25: "epic",
  ach_boost_50: "rare",
  ach_elite_200: "legendary",
  ach_boss_25: "legendary",
  ach_chest_200: "epic",
  ach_crystal_100k: "epic",
  ach_evolution_25: "epic",
  ach_hidden_hard_7: "mythic",
  ach_hidden_marathon: "mythic",
  ach_hidden_level_60: "legendary",
  ach_weapon_spark: "uncommon",
  ach_weapon_knife: "uncommon",
  ach_weapon_wardstone: "uncommon",
  ach_weapon_hearth: "uncommon",
  ach_weapon_storm: "uncommon",
  ach_weapon_sting: "uncommon",
};

/** Семь статусных и сезонных знаков: [id, название, вид, категория, редкость, подсказка]. */
const SPECIAL: readonly (readonly [string, string, string, string, string, string])[] = [
  ["emb_vip", "VIP", "status", "status", "legendary", "Оформить VIP"],
  ["emb_tester", "Тестер", "status", "status", "rare", "Играть в закрытом тесте"],
  ["emb_supporter", "Меценат", "status", "status", "epic", "Поддержать проект"],
  ["emb_team", "Команда", "status", "status", "team", "Работать в команде игры"],
  ["emb_season_champion", "Чемпион", "season", "season", "mythic", "Занять первое место в недельном сезоне"],
  ["emb_season_top10", "Топ-10", "season", "season", "legendary", "Войти в десятку недельного сезона"],
  ["emb_season_top100", "Топ-100", "season", "season", "epic", "Войти в сотню недельного сезона"],
];

describe.skipIf(!live)("знаки у имени на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let tasksRepository: PrismaTasksRepository;
  let achievementsRepository: PrismaAchievementsRepository;
  let emblemsRepository: PrismaEmblemsRepository;
  let vip: PrismaVipRepository;
  let tasks: TasksService;
  let emblems: EmblemsService;
  let achievements: AchievementsService;
  /** Сколько запросов `$queryRaw` ушло в базу через репозиторий знаков. */
  let queries = 0;
  const settings = panelSettings();

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(940_000_000 + Math.floor(Math.random() * 15_000_000)), displayName: "Знаки", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function player(): Promise<AccountRef> {
    return { accountId: await account(), platform: "telegram", platformUserId: "1" };
  }

  async function makeTester(accountId: string): Promise<void> {
    await prisma.$executeRaw`UPDATE account SET tester_at = now() WHERE account_id = ${accountId}::uuid`;
  }

  async function makeSupporter(accountId: string): Promise<void> {
    await prisma.$executeRaw`UPDATE account SET supporter_at = now() WHERE account_id = ${accountId}::uuid`;
  }

  async function grantRole(accountId: string, role: string): Promise<void> {
    await prisma.$executeRaw`INSERT INTO account_role (account_id, role) VALUES (${accountId}::uuid, ${role}::"Role")`;
  }

  /** VIP через настоящий журнал периодов: оплата `paidAt`, период `periodSec`. */
  async function giveVip(accountId: string, paidAt: Date, periodSec: number): Promise<void> {
    const purchaseId = randomUUID();
    await prisma.purchase.create({
      data: {
        purchaseId,
        accountId,
        product: "vip",
        sku: "vip_month",
        priceStars: 200,
        chargedStars: 200,
        mode: "live",
        status: "paid",
        telegramChargeId: `emb-${purchaseId}`,
        invoicedAt: paidAt,
        paidAt,
      },
    });
    await vip.addPeriod({ purchaseId, subscriptionId: purchaseId, accountId, paidAt, periodSec, at: paidAt });
  }

  /** Достижения выполнены напрямую, мимо забега. */
  async function complete(accountId: string, ...taskIds: string[]): Promise<void> {
    const at = new Date();
    await prisma.$executeRaw`
      INSERT INTO task_progress (account_id, task_id, period_start, value, target, completed_at, updated_at)
      SELECT ${accountId}::uuid, d.task_id, DATE '2000-01-01', d.target, d.target, ${at}, ${at}
      FROM task_def d WHERE d.task_id = ANY(${taskIds}::text[])
      ORDER BY d.sort, d.task_id
      ON CONFLICT (account_id, task_id, period_start) DO NOTHING`;
  }

  async function finishedRun(accountId: string): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO run (run_id, account_id, status, difficulty, starting_weapon_id, content_hash, finished_at, survival_sec)
      VALUES (${`emb-row-${randomBytes(6).toString("hex")}`}, ${accountId}::uuid, 'finished'::"RunStatus", 'hard', 'spark', 'hash', now(), 100)`;
  }

  async function closedSeason(key: string): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO season (season_key, starts_at, ends_at, closed_at, players, rewarded)
      VALUES (${key}, ${key}::date, ${key}::date + 7, ${key}::date + 7, 1, 0) ON CONFLICT (season_key) DO NOTHING`;
  }

  async function seasonResult(accountId: string, key: string, place: number, boardSize: number, difficulty = "hard"): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO season_result (season_key, account_id, difficulty, best_sec, place, board_size)
      VALUES (${key}, ${accountId}::uuid, ${difficulty}::"Difficulty", 100, ${place}, ${boardSize})`;
  }

  /** Номер сезона по ключу — порядковый среди закрытых: независимая от кода проверка. */
  async function seasonNumber(key: string): Promise<number> {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM season WHERE season_key <= ${key}`;
    return row?.n ?? 0;
  }

  async function shownOf(accountId: string): Promise<string | null> {
    const marks = await emblems.of([accountId]);
    return marks.get(accountId)?.emblem?.id ?? null;
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    tasksRepository = new PrismaTasksRepository(prisma);
    achievementsRepository = new PrismaAchievementsRepository(prisma);
    vip = new PrismaVipRepository(prisma);
    // Счётчик запросов: репозиторий знаков получает тот же клиент, но каждый `$queryRaw` считается.
    const counted = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "$queryRaw") {
          return (...args: Parameters<PrismaClient["$queryRaw"]>) => {
            queries += 1;
            return target.$queryRaw(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    emblemsRepository = new PrismaEmblemsRepository(counted);
    const unused = {} as never;
    const rolesStub = { require: async () => undefined, audit: async () => undefined } as unknown as RolesService;
    const wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    tasks = new TasksService(tasksRepository, wallet, new RunsHooks(), rolesStub, unused, unused, unused);
    emblems = new EmblemsService(tasks, emblemsRepository, achievementsRepository, settings);
    const friends = new PrismaFriendsRepository(prisma);
    achievements = new AchievementsService(
      tasks,
      achievementsRepository,
      { friendCount: (accountId) => friends.count(accountId) },
      new ProgressService(new PrismaProgressRepository(prisma)),
      settings,
      emblems,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    queries = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("миграция", () => {
    it("у 24 отобранных достижений редкость знака по таблице; других, кроме семи новых, знаков нет", async () => {
      const rows = await prisma.$queryRaw<{ task_id: string; emblem_tier: string }[]>`
        SELECT task_id, emblem_tier FROM task_def WHERE emblem_tier IS NOT NULL AND task_id NOT LIKE 'it\_%' ORDER BY task_id`;
      const merit = rows.filter((row) => !row.task_id.startsWith("emb_"));
      expect(Object.fromEntries(merit.map((row) => [row.task_id, row.emblem_tier]))).toEqual(MERIT_TIERS);
      expect(merit.length).toBe(24);
      expect(rows.length).toBe(24 + SPECIAL.length);
    });

    it("семь новых строк: вид, категория, редкость, подсказка, цель 1, награда 0, порядок с 900 шагом 10", async () => {
      const rows = await prisma.$queryRaw<
        { task_id: string; title: string; period: string; kind: string; category: string; emblem_tier: string; hint: string; target: number; coins: number; gems: number; shards: number; pass_points: number; prestige: number; hidden: boolean; active: boolean; sort: number }[]
      >`SELECT task_id, title, period::text, kind, category, emblem_tier, hint, target, coins, gems, shards, pass_points, prestige, hidden, active, sort FROM task_def WHERE task_id LIKE 'emb\_%' ORDER BY sort`;
      expect(rows.map((row) => row.task_id)).toEqual(SPECIAL.map(([id]) => id));
      SPECIAL.forEach(([id, title, kind, category, tier, hint], index) => {
        expect(rows[index], id).toMatchObject({
          task_id: id,
          title,
          period: "achievement",
          kind,
          category,
          emblem_tier: tier,
          hint,
          target: 1,
          coins: 0,
          gems: 0,
          shards: 0,
          pass_points: 0,
          prestige: 0,
          hidden: false,
          active: true,
          sort: 900 + index * 10,
        });
      });
    });

    it("база не пускает знак у задания дня, редкость вне шкалы, награду 0 у обычного вида и несогласованную категорию", async () => {
      const taskId = `it_emb_${STAMP}`;
      const insert = (patch: { period?: string; kind?: string; category?: string | null; tier?: string | null; coins?: number }) =>
        prisma.$executeRaw`
          INSERT INTO task_def (task_id, period, kind, target, coins, category, emblem_tier, active, created_at, updated_at)
          VALUES (${taskId}, ${patch.period ?? "achievement"}::"TaskPeriod", ${patch.kind ?? "runs"}, 1, ${patch.coins ?? 10}, ${patch.category ?? null}, ${patch.tier ?? null}, false, now(), now())`;
      try {
        await expect(insert({ period: "daily", tier: "rare" })).rejects.toThrow();
        await expect(insert({ period: "weekly", tier: "team" })).rejects.toThrow();
        await expect(insert({ category: "combat", tier: "gold" })).rejects.toThrow();
        await expect(insert({ category: "pvp" })).rejects.toThrow();
        await expect(insert({ coins: 0 })).rejects.toThrow();
        await expect(insert({ kind: "kills", category: "combat", coins: 0 })).rejects.toThrow();
        // вид и категория знака идут парой: status — status, season — season
        await expect(insert({ kind: "status", category: "combat", tier: "rare", coins: 0 })).rejects.toThrow();
        await expect(insert({ kind: "status", category: "season", tier: "rare", coins: 0 })).rejects.toThrow();
        await expect(insert({ kind: "season", category: null, tier: "rare", coins: 0 })).rejects.toThrow();
        await expect(insert({ kind: "runs", category: "status" })).rejects.toThrow();
        await expect(insert({ kind: "kills", category: "season" })).rejects.toThrow();
        // допустимое проходит: знак у достижения, знак «Команды», статус без награды
        await expect(insert({ category: "combat", tier: "epic" })).resolves.toBe(1);
        await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${taskId}`;
        await expect(insert({ category: "combat", tier: "team" })).resolves.toBe(1);
        await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${taskId}`;
        await expect(insert({ kind: "status", category: "status", tier: "rare", coins: 0 })).resolves.toBe(1);
        await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${taskId}`;
        await expect(insert({ kind: "season", category: "season", tier: "mythic", coins: 0 })).resolves.toBe(1);
      } finally {
        await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${taskId}`;
      }
    });

    it("выбранный знак — внешний ключ на каталог: чужой id база не примет, удалённая строка сбросит выбор", async () => {
      const me = await account();
      await expect(prisma.$executeRaw`UPDATE account SET shown_emblem_id = 'no_such_emblem' WHERE account_id = ${me}::uuid`).rejects.toThrow();
      const taskId = `it_emb_fk_${STAMP}`;
      await prisma.$executeRaw`
        INSERT INTO task_def (task_id, period, kind, target, coins, category, emblem_tier, active, created_at, updated_at)
        VALUES (${taskId}, 'achievement'::"TaskPeriod", 'runs', 1, 10, 'mastery', 'rare', false, now(), now())`;
      await prisma.$executeRaw`UPDATE account SET shown_emblem_id = ${taskId} WHERE account_id = ${me}::uuid`;
      await prisma.$executeRaw`DELETE FROM task_def WHERE task_id = ${taskId}`;
      const [row] = await prisma.$queryRaw<{ shown_emblem_id: string | null }[]>`SELECT shown_emblem_id FROM account WHERE account_id = ${me}::uuid`;
      expect(row?.shown_emblem_id).toBeNull();
    });
  });

  describe("какой знак у имени", () => {
    it("у тестера без выбора — «Тестер»: название и редкость из каталога, группа status, номера сезона нет", async () => {
      const me = await account();
      await makeTester(me);
      const marks = await emblems.of([me]);
      expect(marks.get(me)).toStrictEqual({ emblem: { id: "emb_tester", title: "Тестер", tier: "rare", category: "status" } });
    });

    it("у обычного игрока знака нет, но запись в карте есть — пустая", async () => {
      const me = await account();
      const marks = await emblems.of([me]);
      expect(marks.get(me)).toStrictEqual({});
    });

    it("по умолчанию Меценат важнее Тестера, VIP важнее Мецената, Команда важнее VIP", async () => {
      const both = await account();
      await makeTester(both);
      await makeSupporter(both);
      expect(await shownOf(both)).toBe("emb_supporter");

      await giveVip(both, new Date(Date.now() - DAY), 30 * 86_400);
      expect(await shownOf(both)).toBe("emb_vip");

      await grantRole(both, "moderator");
      expect(await shownOf(both)).toBe("emb_team");
    });

    it("роль внешнего партнёра знака «Команда» не даёт: партнёр не работает в команде игры", async () => {
      const partner = await account();
      await grantRole(partner, "partner");
      expect(await shownOf(partner)).toBeNull();
      const staff = await account();
      await grantRole(staff, "analyst");
      expect(await shownOf(staff)).toBe("emb_team");
    });

    it("выбранный «Последний рубеж» — он, с категорией merit; сменить обратно на «по умолчанию» можно", async () => {
      const me = await account();
      await makeTester(me);
      await complete(me, "ach_survive_20");
      await emblems.choose(me, "ach_survive_20");
      const marks = await emblems.of([me]);
      expect(marks.get(me)).toStrictEqual({ emblem: { id: "ach_survive_20", title: "Последний рубеж", tier: "epic", category: "merit" } });

      await emblems.choose(me, null);
      expect(await shownOf(me)).toBe("emb_tester");
    });

    it("VIP истёк — выбранный emb_vip сменяется знаком по умолчанию, выбор в базе остаётся и возвращается вместе с VIP", async () => {
      const me = await account();
      await makeTester(me);
      await giveVip(me, new Date(Date.now() - DAY), 30 * 86_400);
      await emblems.choose(me, "emb_vip");
      expect(await shownOf(me)).toBe("emb_vip");

      await prisma.$executeRaw`UPDATE vip_period SET starts_at = starts_at - interval '60 days', ends_at = now() - interval '1 hour' WHERE account_id = ${me}::uuid`;
      expect(await shownOf(me)).toBe("emb_tester");
      const [row] = await prisma.$queryRaw<{ shown_emblem_id: string | null }[]>`SELECT shown_emblem_id FROM account WHERE account_id = ${me}::uuid`;
      expect(row?.shown_emblem_id).toBe("emb_vip");

      await prisma.$executeRaw`UPDATE vip_period SET ends_at = now() + interval '1 day' WHERE account_id = ${me}::uuid`;
      expect(await shownOf(me)).toBe("emb_vip");
    });

    it("на список из 50 аккаунтов — по одному запросу на источник: четыре, а не по четыре на строку", async () => {
      const ids: string[] = [];
      for (let index = 0; index < 50; index++) {
        const id = await account();
        if (index % 2 === 0) await makeTester(id);
        ids.push(id);
      }
      queries = 0;
      const marks = await emblems.of(ids);
      expect(queries).toBe(4);
      expect(marks.size).toBe(50);
      expect(marks.get(ids[0] ?? "")?.emblem?.id).toBe("emb_tester");
      expect(marks.get(ids[1] ?? "")).toStrictEqual({});
    });

    it("пустой список и не-uuid не ходят в базу и не роняют запрос", async () => {
      queries = 0;
      expect((await emblems.of([])).size).toBe(0);
      const marks = await emblems.of(["not-a-uuid", "'; DROP TABLE account; --"]);
      expect(marks.size).toBe(0);
      expect(queries).toBe(0);
    });

    it("повтор одного id в списке не удваивает запросы и ответ", async () => {
      const me = await account();
      await makeTester(me);
      queries = 0;
      const marks = await emblems.of([me, me, me]);
      expect(marks.size).toBe(1);
      expect(queries).toBe(4);
    });
  });

  describe("сезонные знаки", () => {
    it("место 3 в сезоне с таблицей на 12 игроков — «Топ-10» и «Топ-100»; номер сезона — порядковый среди закрытых", async () => {
      const me = await account();
      const key = "2091-03-04";
      await closedSeason(key);
      await seasonResult(me, key, 3, 12);
      const view = await emblems.listFor(me);
      const byId = new Map(view.items.map((item) => [item.id, item]));
      const number = await seasonNumber(key);
      expect(byId.get("emb_season_champion")?.held).toBe(false);
      expect(byId.get("emb_season_top10")).toMatchObject({ held: true, season: number, category: "season", tier: "legendary", title: "Топ-10" });
      expect(byId.get("emb_season_top100")).toMatchObject({ held: true, season: number });
      expect(byId.get("emb_season_champion")?.season).toBeUndefined();
      expect(view.shown).toBeNull();

      await emblems.choose(me, "emb_season_top10");
      const marks = await emblems.of([me]);
      expect(marks.get(me)?.emblem).toStrictEqual({ id: "emb_season_top10", title: "Топ-10", tier: "legendary", category: "season", season: number });
    });

    it("та же строка при таблице на 8 игроков знака не даёт: награждаются только доски не меньше MIN_BOARD", async () => {
      const me = await account();
      const key = "2092-03-04";
      await closedSeason(key);
      await seasonResult(me, key, 3, 8);
      const view = await emblems.listFor(me);
      for (const id of ["emb_season_champion", "emb_season_top10", "emb_season_top100"]) expect(view.items.find((item) => item.id === id)?.held, id).toBe(false);
      await expect(emblems.choose(me, "emb_season_top10")).rejects.toBeInstanceOf(EmblemNotHeldError);
    });

    it("у каждого порога свой последний сезон: чемпион — давний, топ-10 — следующий, топ-100 — свежий", async () => {
      const me = await account();
      const [a, b, c] = ["2093-04-05", "2093-04-12", "2093-04-19"] as const;
      for (const key of [a, b, c]) await closedSeason(key);
      await seasonResult(me, a, 1, 12);
      await seasonResult(me, b, 5, 20, "normal");
      await seasonResult(me, c, 50, 60);
      const view = await emblems.listFor(me);
      const seasonOf = (id: string) => view.items.find((item) => item.id === id)?.season;
      expect(seasonOf("emb_season_champion")).toBe(await seasonNumber(a));
      expect(seasonOf("emb_season_top10")).toBe(await seasonNumber(b));
      expect(seasonOf("emb_season_top100")).toBe(await seasonNumber(c));
      expect(await seasonNumber(b)).toBe((await seasonNumber(a)) + 1);
      expect(await seasonNumber(c)).toBe((await seasonNumber(a)) + 2);
    });

    it("место 101 знака не даёт", async () => {
      const me = await account();
      const key = "2094-05-06";
      await closedSeason(key);
      await seasonResult(me, key, 101, 200);
      const view = await emblems.listFor(me);
      expect(view.items.filter((item) => item.category === "season").every((item) => !item.held)).toBe(true);
    });
  });

  describe("знаки игрока: GET /achievements/emblems", () => {
    it("в каталоге 31 знак: статусные и сезонные, затем заслуги; держимые отмечены, shown и auto — по умолчанию", async () => {
      const me = await account();
      await makeTester(me);
      await complete(me, "ach_runs_200", "ach_weapon_spark");
      const view = await emblems.listFor(me);
      expect(view.items.length).toBe(24 + SPECIAL.length);
      expect(view.shown).toBe("emb_tester");
      expect(view.auto).toBe(true);
      const held = view.items.filter((item) => item.held).map((item) => item.id).sort();
      expect(held).toEqual(["ach_runs_200", "ach_weapon_spark", "emb_tester"]);
      const item = (id: string) => view.items.find((candidate) => candidate.id === id);
      expect(item("emb_vip")).toMatchObject({ held: false, category: "status", tier: "legendary", title: "VIP", hint: "Оформить VIP" });
      expect(item("ach_runs_200")).toMatchObject({ held: true, category: "merit", tier: "epic", title: "Старожил" });
      expect(item("ach_kills_100k")).toMatchObject({ held: false, category: "merit", tier: "legendary" });
    });

    it("выбор есть и держится — auto false; выбранный перестал держаться — снова auto true", async () => {
      const me = await account();
      await makeTester(me);
      await complete(me, "ach_survive_20");
      await emblems.choose(me, "ach_survive_20");
      let view = await emblems.listFor(me);
      expect(view).toMatchObject({ shown: "ach_survive_20", auto: false });

      await prisma.$executeRaw`DELETE FROM task_progress WHERE account_id = ${me}::uuid AND task_id = 'ach_survive_20'`;
      view = await emblems.listFor(me);
      expect(view).toMatchObject({ shown: "emb_tester", auto: true });
    });

    it("никакого знака нет — shown null, auto true", async () => {
      const me = await account();
      expect(await emblems.listFor(me)).toMatchObject({ shown: null, auto: true });
    });

    it("закрытое скрытое отдаёт подсказку, но не название; открытое — полностью", async () => {
      const me = await account();
      let view = await emblems.listFor(me);
      const closed = view.items.find((item) => item.id === "ach_hidden_marathon");
      expect(closed).toMatchObject({ held: false, title: HIDDEN_EMBLEM_TITLE, hint: "Продержаться очень, очень долго", percent: null, category: "merit", tier: "mythic" });
      expect(JSON.stringify(closed)).not.toContain("Марафонец");

      await complete(me, "ach_hidden_marathon");
      view = await emblems.listFor(me);
      expect(view.items.find((item) => item.id === "ach_hidden_marathon")).toMatchObject({ held: true, title: "Марафонец" });
    });

    it("«есть у N %» берётся из прохода редкости и есть у статусных знаков; ниже порога населения — null", async () => {
      const me = await account();
      const lowSettings = panelSettings({ [SETTINGS.achievementsRarityMinPlayers.key]: 1 });
      const service = new EmblemsService(tasks, emblemsRepository, achievementsRepository, lowSettings);
      await finishedRun(me);
      await makeTester(me);
      await achievementsRepository.recomputeRarity(new Date());
      const view = await service.listFor(me);
      const tester = view.items.find((item) => item.id === "emb_tester");
      expect(tester?.percent).not.toBeNull();
      expect(tester?.percent ?? 0).toBeGreaterThan(0);

      const strict = new EmblemsService(tasks, emblemsRepository, achievementsRepository, panelSettings({ [SETTINGS.achievementsRarityMinPlayers.key]: 100_000 }));
      expect((await strict.listFor(me)).items.every((item) => item.percent === null)).toBe(true);
    });
  });

  describe("выбор знака: PUT /achievements/emblem", () => {
    it("держимый — выбирается; недержимый — 409 emblem_not_held; нет в каталоге — 404 emblem_not_found", async () => {
      const me = await account();
      await makeTester(me);
      expect(await emblems.choose(me, "emb_tester")).toEqual({ shown: "emb_tester", auto: false });
      await expect(emblems.choose(me, "emb_vip")).rejects.toBeInstanceOf(EmblemNotHeldError);
      await expect(emblems.choose(me, "ach_kills_100k")).rejects.toBeInstanceOf(EmblemNotHeldError);
      await expect(emblems.choose(me, "ach_kills_100")).rejects.toBeInstanceOf(EmblemNotFoundError);
      await expect(emblems.choose(me, "no_such_emblem")).rejects.toBeInstanceOf(EmblemNotFoundError);
      // отказ ничего не менял
      expect(await shownOf(me)).toBe("emb_tester");
    });

    it("null возвращает «по умолчанию»; повтор того же выбора ничего не пишет", async () => {
      const me = await account();
      await makeTester(me);
      await makeSupporter(me);
      expect(await emblems.choose(me, "emb_tester")).toEqual({ shown: "emb_tester", auto: false });
      expect(await emblems.choose(me, "emb_tester")).toEqual({ shown: "emb_tester", auto: false });
      expect(await emblems.choose(me, null)).toEqual({ shown: "emb_supporter", auto: true });
      expect(await emblems.choose(me, null)).toEqual({ shown: "emb_supporter", auto: true });
    });

    it("повтор того же выбора не трогает строку аккаунта", async () => {
      const me = await account();
      await makeTester(me);
      await emblems.choose(me, "emb_tester");
      const [before] = await prisma.$queryRaw<{ xmin: string }[]>`SELECT xmin::text AS xmin FROM account WHERE account_id = ${me}::uuid`;
      await emblems.choose(me, "emb_tester");
      const [after] = await prisma.$queryRaw<{ xmin: string }[]>`SELECT xmin::text AS xmin FROM account WHERE account_id = ${me}::uuid`;
      expect(after?.xmin).toBe(before?.xmin);
    });

    it("выключенный в панели знак выбрать нельзя и в карте он не показывается", async () => {
      const me = await account();
      await makeSupporter(me);
      await prisma.$executeRaw`UPDATE task_def SET active = false WHERE task_id = 'emb_supporter'`;
      tasks.forgetCatalog();
      try {
        await expect(emblems.choose(me, "emb_supporter")).rejects.toBeInstanceOf(EmblemNotFoundError);
        expect(await shownOf(me)).toBeNull();
        expect((await emblems.listFor(me)).items.some((item) => item.id === "emb_supporter")).toBe(false);
      } finally {
        await prisma.$executeRaw`UPDATE task_def SET active = true WHERE task_id = 'emb_supporter'`;
        tasks.forgetCatalog();
      }
    });
  });

  describe("задания и достижения", () => {
    const at = new Date(Date.UTC(2026, 9, 21, 9));

    it("GET /tasks не отдаёт строк status и season, а POST /tasks/emb_vip/claim отвечает как на чужое — 404 task_not_found", async () => {
      const me = await player();
      await makeTester(me.accountId);
      await giveVip(me.accountId, new Date(Date.now() - DAY), 30 * 86_400);
      const view = await tasks.view(me, at);
      expect(view.some((task) => task.id.startsWith("emb_"))).toBe(false);
      expect(view.some((task) => task.id === "ach_survive_20")).toBe(true);
      for (const id of SPECIAL.map(([emblem]) => emblem)) {
        const error: unknown = await tasks.claim(me, id, at).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error, id).toBeInstanceOf(TaskNotFoundError);
        expect(error).toMatchObject({ code: "task_not_found", status: 404 });
      }
    });

    it("витрина достижений: держимый статусный знак выполнен, недержимый — нет, награды и престижа у них нет", async () => {
      const me = await player();
      await makeTester(me.accountId);
      const view = await achievements.view(me, at);
      const tester = view.items.find((item) => item.id === "emb_tester");
      const vipItem = view.items.find((item) => item.id === "emb_vip");
      expect(tester).toMatchObject({ category: "status", done: true, claimed: true, reward: { coins: 0, gems: 0, shards: 0 }, prestige: 0, hint: "Играть в закрытом тесте" });
      expect(vipItem).toMatchObject({ category: "status", done: false, claimed: false });
      expect(view.prestige).toBe(0);
    });

    it("«любимые» принимают держимый emb_tester и не принимают недержимый emb_vip", async () => {
      const me = await player();
      await makeTester(me.accountId);
      await expect(achievements.setFavorites(me.accountId, ["emb_vip"])).rejects.toBeInstanceOf(AchievementNotUnlockedError);
      await expect(achievements.setFavorites(me.accountId, ["emb_tester", "emb_vip"])).rejects.toBeInstanceOf(AchievementNotUnlockedError);
      expect(await achievements.setFavorites(me.accountId, ["emb_tester"])).toEqual({ favorites: ["emb_tester"] });
      await complete(me.accountId, "ach_kills_100");
      expect(await achievements.setFavorites(me.accountId, ["ach_kills_100", "emb_tester"])).toEqual({ favorites: ["ach_kills_100", "emb_tester"] });
      const summary = await achievements.summary(me.accountId);
      expect(summary.favorites.map((favorite) => favorite.id)).toEqual(["ach_kills_100", "emb_tester"]);
    });

    it("знак, переставший держаться, из любимых в витрине и сводке пропадает без снятия — и возвращается, если держится снова", async () => {
      const me = await player();
      await giveVip(me.accountId, new Date(Date.now() - DAY), 30 * 86_400);
      expect(await achievements.setFavorites(me.accountId, ["emb_vip"])).toEqual({ favorites: ["emb_vip"] });
      await prisma.$executeRaw`UPDATE vip_period SET starts_at = starts_at - interval '60 days', ends_at = now() - interval '1 hour' WHERE account_id = ${me.accountId}::uuid`;
      expect((await achievements.view(me, at)).favorites).toEqual([]);
      expect((await achievements.summary(me.accountId)).favorites).toEqual([]);
      await prisma.$executeRaw`UPDATE vip_period SET ends_at = now() + interval '1 day' WHERE account_id = ${me.accountId}::uuid`;
      expect((await achievements.view(me, at)).favorites).toEqual(["emb_vip"]);
    });
  });

  describe("проход редкости", () => {
    it("держатели статусных и сезонных знаков считаются среди игроков с забегом по правилам знаков, одним проходом", async () => {
      const tester = await account();
      const vipPlayer = await account();
      const expiredVip = await account();
      const staff = await account();
      const partner = await account();
      const champion = await account();
      const small = await account();
      for (const id of [tester, vipPlayer, expiredVip, staff, partner, champion, small]) await finishedRun(id);
      await makeTester(tester);
      await giveVip(vipPlayer, new Date(Date.now() - DAY), 30 * 86_400);
      await giveVip(expiredVip, new Date(Date.now() - 90 * DAY), 30 * 86_400);
      await grantRole(staff, "moderator");
      await grantRole(partner, "partner");
      const key = "2095-06-07";
      await closedSeason(key);
      await seasonResult(champion, key, 1, 30);
      await seasonResult(small, key, 1, 5);

      const now = new Date();
      await achievementsRepository.recomputeRarity(now);
      const rarity = await achievementsRepository.rarity();

      // Независимый подсчёт того же населения и тех же правил.
      const [expected] = await prisma.$queryRaw<{ pop: number; tester: number; supporter: number; vip: number; team: number; champion: number; top10: number; top100: number }[]>`
        WITH pop AS (SELECT a.account_id FROM account a WHERE EXISTS (SELECT 1 FROM run r WHERE r.account_id = a.account_id AND r.status = 'finished'))
        SELECT
          (SELECT count(*) FROM pop)::int AS pop,
          (SELECT count(*) FROM pop JOIN account a USING (account_id) WHERE a.tester_at IS NOT NULL)::int AS tester,
          (SELECT count(*) FROM pop JOIN account a USING (account_id) WHERE a.supporter_at IS NOT NULL)::int AS supporter,
          (SELECT count(DISTINCT v.account_id) FROM pop JOIN vip_period v USING (account_id) WHERE v.ends_at > ${now}::timestamptz)::int AS vip,
          (SELECT count(DISTINCT r.account_id) FROM pop JOIN account_role r USING (account_id) WHERE r.role <> 'partner')::int AS team,
          (SELECT count(DISTINCT s.account_id) FROM pop JOIN season_result s USING (account_id) WHERE s.board_size >= 10 AND s.place <= 1)::int AS champion,
          (SELECT count(DISTINCT s.account_id) FROM pop JOIN season_result s USING (account_id) WHERE s.board_size >= 10 AND s.place <= 10)::int AS top10,
          (SELECT count(DISTINCT s.account_id) FROM pop JOIN season_result s USING (account_id) WHERE s.board_size >= 10 AND s.place <= 100)::int AS top100`;
      const holders = (id: string) => rarity.rows.get(id)?.holders;
      expect(rarity.rows.get("emb_tester")?.population).toBe(expected?.pop);
      expect(holders("emb_tester")).toBe(expected?.tester);
      expect(holders("emb_supporter")).toBe(expected?.supporter);
      expect(holders("emb_vip")).toBe(expected?.vip);
      expect(holders("emb_team")).toBe(expected?.team);
      expect(holders("emb_season_champion")).toBe(expected?.champion);
      expect(holders("emb_season_top10")).toBe(expected?.top10);
      expect(holders("emb_season_top100")).toBe(expected?.top100);
      // свои игроки в счёте: тестер, VIP, команда и чемпион — по одному, просроченный VIP, партнёр и малая доска — нет
      expect(holders("emb_tester") ?? 0).toBeGreaterThanOrEqual(1);
      expect(holders("emb_vip") ?? 0).toBeGreaterThanOrEqual(1);
      expect(holders("emb_team") ?? 0).toBeGreaterThanOrEqual(1);
      expect(holders("emb_season_champion") ?? 0).toBeGreaterThanOrEqual(1);
    });

    it("после прохода у каждого знака каталога есть строка редкости", async () => {
      await achievementsRepository.recomputeRarity(new Date());
      const rarity = await achievementsRepository.rarity();
      for (const [id] of SPECIAL) expect(rarity.rows.has(id), id).toBe(true);
      for (const id of Object.keys(MERIT_TIERS)) expect(rarity.rows.has(id), id).toBe(true);
    });
  });

  describe("панель: правка строк знаков", () => {
    async function current(taskId: string): Promise<TaskDef> {
      const found = (await tasksRepository.catalog()).find((task) => task.taskId === taskId);
      if (found === undefined) throw new Error(`нет строки ${taskId}`);
      return found;
    }
    const actor: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "1" };

    it("название, подсказка, редкость, порядок и «включено» у статусного знака меняются, и новая редкость видна у имени", async () => {
      const before = await current("emb_tester");
      const me = await account();
      await makeTester(me);
      try {
        const saved = await tasks.save(actor, { ...before, title: "Тестер-ветеран", hint: "Играть в закрытом тесте до вайпа", emblemTier: "epic" });
        expect(saved).toMatchObject({ title: "Тестер-ветеран", emblemTier: "epic", sort: before.sort });
        expect((await emblems.of([me])).get(me)?.emblem).toStrictEqual({ id: "emb_tester", title: "Тестер-ветеран", tier: "epic", category: "status" });
      } finally {
        await tasks.save(actor, before);
      }
      expect(await current("emb_tester")).toEqual(before);
    });

    it("вид и срок знака не меняются, а новый знак вида status или season панель завести не может", async () => {
      const before = await current("emb_vip");
      await expect(tasks.save(actor, { ...before, kind: "season", category: "season" })).rejects.toBeInstanceOf(TaskShapeLockedError);
      await expect(tasks.save(actor, { ...before, taskId: `emb_new_${STAMP}` })).rejects.toMatchObject({ code: "task_emblem_fixed", status: 409 });
      expect((await tasksRepository.catalog()).some((task) => task.taskId === `emb_new_${STAMP}`)).toBe(false);
      expect(await current("emb_vip")).toEqual(before);
    });

    it("редкость знака у обычного достижения ставится и снимается", async () => {
      const before = await current("ach_boost_1");
      try {
        await tasks.save(actor, { ...before, emblemTier: "common" });
        expect((await current("ach_boost_1")).emblemTier).toBe("common");
        const me = await account();
        await complete(me, "ach_boost_1");
        expect((await emblems.listFor(me)).items.find((item) => item.id === "ach_boost_1")).toMatchObject({ held: true, tier: "common", category: "merit" });
        await tasks.save(actor, { ...before, emblemTier: null });
        expect((await emblems.listFor(me)).items.some((item) => item.id === "ach_boost_1")).toBe(false);
      } finally {
        await tasks.save(actor, before);
      }
      expect(await current("ach_boost_1")).toEqual(before);
    });
  });

  describe("по HTTP", () => {
    let app: NestFastifyApplication | null = null;

    afterEach(async () => {
      await app?.close();
      app = null;
    });

    async function boot(): Promise<NestFastifyApplication> {
      @Module({
        controllers: [EmblemsController],
        providers: [{ provide: APP_CONFIG, useValue: config }, { provide: REDIS, useValue: redis }, { provide: EmblemsService, useValue: emblems }, RateLimiter, AuthGuard],
      })
      class TestModule {}
      const created = await createHttpApp(TestModule, { logger: false });
      await created.init();
      await created.getHttpAdapter().getInstance().ready();
      app = created;
      return created;
    }

    async function headersOf(me: AccountRef): Promise<Record<string, string>> {
      const token = await signAccessToken({ accountId: me.accountId, platform: "telegram", platformUserId: me.platformUserId }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
      return { authorization: `Bearer ${token}` };
    }

    it("без токена — 401", async () => {
      const http = await boot();
      expect((await http.inject({ method: "GET", url: "/api/v1/achievements/emblems" })).statusCode).toBe(401);
      expect((await http.inject({ method: "PUT", url: "/api/v1/achievements/emblem", payload: { id: null } })).statusCode).toBe(401);
    });

    it("GET отдаёт shown, auto и знаки по форме из задачи", async () => {
      const http = await boot();
      const me = await player();
      await makeTester(me.accountId);
      const response = await http.inject({ method: "GET", url: "/api/v1/achievements/emblems", headers: await headersOf(me) });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: EmblemsView }>().data;
      expect(Object.keys(body).sort()).toEqual(["auto", "items", "shown"]);
      expect(body.shown).toBe("emb_tester");
      expect(body.auto).toBe(true);
      const tester = body.items.find((item) => item.id === "emb_tester");
      expect(Object.keys(tester ?? {}).sort()).toEqual(["category", "held", "hint", "id", "percent", "tier", "title"]);
      expect(tester).toMatchObject({ held: true, title: "Тестер", category: "status", tier: "rare" });
    });

    it("PUT: держит — 200; не держит — 409 с кодом; нет такого — 404 с кодом; null — «по умолчанию»", async () => {
      const http = await boot();
      const me = await player();
      await makeTester(me.accountId);
      const headers = await headersOf(me);
      const put = (payload: unknown) => http.inject({ method: "PUT", url: "/api/v1/achievements/emblem", headers, payload: payload as never });

      const ok = await put({ id: "emb_tester" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ data: unknown }>().data).toEqual({ shown: "emb_tester", auto: false });

      const notHeld = await put({ id: "emb_vip" });
      expect(notHeld.statusCode).toBe(409);
      expect(notHeld.json<{ error: { code: string } }>().error.code).toBe("emblem_not_held");

      const unknown = await put({ id: "no_such_emblem" });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json<{ error: { code: string } }>().error.code).toBe("emblem_not_found");

      const reset = await put({ id: null });
      expect(reset.statusCode).toBe(200);
      expect(reset.json<{ data: unknown }>().data).toEqual({ shown: "emb_tester", auto: true });
    });

    it("PUT: тело не по схеме — 400", async () => {
      const http = await boot();
      const me = await player();
      const headers = await headersOf(me);
      const put = (payload: unknown) => http.inject({ method: "PUT", url: "/api/v1/achievements/emblem", headers, payload: payload as never });
      for (const payload of [{}, { id: 5 }, { id: "DROP TABLE" }, { id: "emb_vip", extra: true }, []]) {
        expect((await put(payload)).statusCode, JSON.stringify(payload)).toBe(400);
      }
    });
  });
});
