import { randomUUID } from "node:crypto";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { IDENTITY_SOURCES, PublicIdentity } from "../src/common/public-identity.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { createPrisma } from "../src/infra/database.js";
import { REDIS, closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaEmblemsRepository } from "../src/modules/achievements/emblems.repository.js";
import { PrismaAchievementsRepository } from "../src/modules/achievements/achievements.repository.js";
import { EmblemsService } from "../src/modules/achievements/emblems.service.js";
import { APPEARANCES } from "../src/modules/appearance/appearance-catalog.js";
import { PrismaAppearanceGrantsRepository } from "../src/modules/appearance/appearance-grants.repository.js";
import { AppearanceLockedError, AppearanceNotFoundError } from "../src/modules/appearance/appearance-errors.js";
import type { AppearanceView } from "../src/modules/appearance/appearance-rules.js";
import { AppearanceController } from "../src/modules/appearance/appearance.controller.js";
import { PrismaAppearanceRepository } from "../src/modules/appearance/appearance.repository.js";
import { AppearanceService } from "../src/modules/appearance/appearance.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { AuthHooks } from "../src/modules/auth/auth-hooks.js";
import type { FriendNotifier } from "../src/modules/friends/friend-notifier.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { FriendsService } from "../src/modules/friends/friends.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import type { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { LeaderboardStore } from "../src/modules/runs/leaderboard.store.js";
import type { RatingRestrictions } from "../src/modules/runs/rating-restrictions.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import type { RunsRepository } from "../src/modules/runs/runs.repository.js";
import type { SeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonsViewService } from "../src/modules/seasons/seasons-view.service.js";
import type { SeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { POINT_STEPS } from "../src/modules/tasks/task-points.js";
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
 * Облики-архетипы на живых Postgres и Redis (tasks/T-0237, docs/35-stage4-plan.md Р150;
 * адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них пропуск).
 *
 * Память этого не покажет: владение считается по таблицам других модулей (уровень, VIP,
 * достижение, ступень недели, место в сезоне), а на список аккаунтов уходит по одному запросу
 * на источник, сколько бы строк ни было.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const DAY = 86_400_000;
const TOP_WEEKLY_POINTS = POINT_STEPS.weekly[POINT_STEPS.weekly.length - 1]?.points ?? 0;

describe.skipIf(!live)("облики на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let friendsRepository: PrismaFriendsRepository;
  let vip: PrismaVipRepository;
  let tasks: TasksService;
  let emblems: EmblemsService;
  let appearance: AppearanceService;
  let identity: PublicIdentity;
  /** Сколько запросов `$queryRaw` ушло в базу через репозитории обликов. */
  let queries = 0;

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(970_000_000 + Math.floor(Math.random() * 15_000_000)), displayName: "Облик", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function player(): Promise<AccountRef> {
    return { accountId: await account(), platform: "telegram", platformUserId: "1" };
  }

  async function setLevel(accountId: string, level: number): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO account_progress (account_id, xp, level, updated_at) VALUES (${accountId}::uuid, 0, ${level}, now())
      ON CONFLICT (account_id) DO UPDATE SET level = ${level}`;
  }

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
        telegramChargeId: `app-${purchaseId}`,
        invoicedAt: paidAt,
        paidAt,
      },
    });
    await vip.addPeriod({ purchaseId, subscriptionId: purchaseId, accountId, paidAt, periodSec, at: paidAt });
  }

  async function expireVip(accountId: string): Promise<void> {
    await prisma.$executeRaw`UPDATE vip_period SET starts_at = starts_at - interval '60 days', ends_at = now() - interval '1 hour' WHERE account_id = ${accountId}::uuid`;
  }

  async function complete(accountId: string, taskId: string): Promise<void> {
    const at = new Date();
    await prisma.$executeRaw`
      INSERT INTO task_progress (account_id, task_id, period_start, value, target, completed_at, updated_at)
      SELECT ${accountId}::uuid, d.task_id, DATE '2000-01-01', d.target, d.target, ${at}, ${at}
      FROM task_def d WHERE d.task_id = ${taskId}
      ON CONFLICT (account_id, task_id, period_start) DO NOTHING`;
  }

  async function claimPoints(accountId: string, period: "daily" | "weekly", points: number): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO task_points_claim (account_id, period, period_start, points, claimed_at)
      VALUES (${accountId}::uuid, ${period}::"TaskPeriod", DATE '2026-11-02', ${points}, now())`;
  }

  async function seasonPlace(accountId: string, key: string, place: number, boardSize: number): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO season (season_key, starts_at, ends_at, closed_at, players, rewarded)
      VALUES (${key}, ${key}::date, ${key}::date + 7, ${key}::date + 7, 1, 0) ON CONFLICT (season_key) DO NOTHING`;
    await prisma.$executeRaw`
      INSERT INTO season_result (season_key, account_id, difficulty, best_sec, place, board_size)
      VALUES (${key}, ${accountId}::uuid, 'hard'::"Difficulty", 100, ${place}, ${boardSize})`;
  }

  async function makeTester(accountId: string): Promise<void> {
    await prisma.$executeRaw`UPDATE account SET tester_at = now() WHERE account_id = ${accountId}::uuid`;
  }

  async function columnsOf(accountId: string): Promise<{ appearance_id: string | null; avatar_photo: boolean }> {
    const [row] = await prisma.$queryRaw<{ appearance_id: string | null; avatar_photo: boolean }[]>`
      SELECT appearance_id, avatar_photo FROM account WHERE account_id = ${accountId}::uuid`;
    if (row === undefined) throw new Error("аккаунта нет");
    return row;
  }

  /** Строка лучшего забега без подробностей: нужны имя и метки. */
  function runRow(accountId: string) {
    return { accountId, runId: randomUUID(), displayName: "Игрок", photoUrl: null, tester: true, supporter: true, points: 90, survivalSec: 100, style: null, level: 3, startingWeaponId: "knife", enemiesKilled: 10 };
  }

  function ratingView(ids: string[]): RunsViewService {
    const runs = { bestRuns: async (rowIds: string[]) => rowIds.map(runRow) } as unknown as RunsRepository;
    const board = {
      top: async () => ids.map((accountId, index) => ({ accountId, score: 1_000 - index })),
      count: async () => ids.length,
      rank: async () => null,
      best: async () => null,
    } as unknown as LeaderboardStore;
    const rating = { boardOf: async () => "common" as const, hold: async () => null, since: () => null } as unknown as RatingRestrictions;
    return new RunsViewService(runs, board, new RunExtras(), rating, new RunPrestige(), undefined, identity);
  }

  function seasonsView(ids: string[]): SeasonsViewService {
    const schedule = new SeasonSchedule(panelSettings({ [SETTINGS.seasonsStartDate.key]: 20261102 }));
    const store = {
      top: async () => ids.map((accountId, index) => ({ accountId, score: 1_000 - index })),
      count: async () => ids.length,
      rank: async () => 1,
      best: async () => 1_000,
    } as unknown as SeasonBoardStore;
    const repository = { boardRuns: async (rowIds: string[]) => rowIds.map(runRow) } as unknown as SeasonsRepository;
    const rating = { boardOf: async () => "common" as const };
    return new SeasonsViewService(schedule, repository, store, {} as never, { status: async () => null } as never, rating as never, identity);
  }

  function friendsService(): FriendsService {
    const notifier = {} as unknown as FriendNotifier;
    const notifications = { readFor: async () => undefined } as unknown as NotificationsService;
    return new FriendsService(config, friendsRepository, accounts, new AuthHooks(), {} as unknown as WalletService, notifier, notifications, {} as never, identity);
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    friendsRepository = new PrismaFriendsRepository(prisma);
    vip = new PrismaVipRepository(prisma);
    // Счётчик запросов: репозитории обликов получают тот же клиент, но каждый `$queryRaw` считается.
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
    const unused = {} as never;
    const rolesStub = { require: async () => undefined, audit: async () => undefined } as unknown as RolesService;
    const wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    tasks = new TasksService(new PrismaTasksRepository(prisma), wallet, new RunsHooks(), rolesStub, unused, unused, unused);
    emblems = new EmblemsService(tasks, new PrismaEmblemsRepository(prisma), new PrismaAchievementsRepository(prisma), panelSettings());
    appearance = new AppearanceService(tasks, new PrismaAppearanceRepository(counted), new PrismaEmblemsRepository(counted), new PrismaAppearanceGrantsRepository(counted));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    queries = 0;
    identity = new PublicIdentity();
    identity.provide({ of: async (ids) => await emblems.of(ids) }, IDENTITY_SOURCES.emblem);
    identity.provide({ of: async (ids) => await appearance.of(ids) }, IDENTITY_SOURCES.appearance);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("владение", () => {
    it("новичок: держит только Хранителя, выбор не задан", async () => {
      const me = await account();

      const view = await appearance.viewFor(me);

      expect(view).toMatchObject({ selected: "keeper", effective: "keeper", avatarPhoto: false });
      expect(view.items).toHaveLength(11);
      expect(view.items.filter((item) => item.held).map((item) => item.id)).toEqual(["keeper"]);
    });

    it("уровень аккаунта открывает Хранителя в окрасах и Витязя", async () => {
      const me = await account();
      await setLevel(me, 15);
      expect((await appearance.viewFor(me)).items.filter((item) => item.held).map((item) => item.id)).toEqual(["keeper", "frost", "herbalist", "gilded"]);

      await setLevel(me, 20);

      expect((await appearance.viewFor(me)).items.filter((item) => item.held).map((item) => item.id)).toEqual(["keeper", "frost", "herbalist", "gilded", "vityaz"]);
    });

    it("«Гроза элит» выполнена — Охотница; у источника-достижения есть название из каталога", async () => {
      const me = await account();
      await complete(me, "ach_elite_50");

      const view = await appearance.viewFor(me);

      expect(view.items.find((item) => item.id === "ohotnitsa")).toMatchObject({ held: true, source: { kind: "achievement", achievementId: "ach_elite_50", title: "Гроза элит" } });
    });

    it("верхняя ступень недели забрана — Ведунья; нижняя и верхняя ступень дня — нет", async () => {
      const me = await account();
      const lower = POINT_STEPS.weekly[0]?.points ?? 0;
      await claimPoints(me, "weekly", lower);
      await claimPoints(me, "daily", TOP_WEEKLY_POINTS);
      expect((await appearance.viewFor(me)).items.find((item) => item.id === "vedunya")?.held).toBe(false);

      await claimPoints(me, "weekly", TOP_WEEKLY_POINTS);

      expect((await appearance.viewFor(me)).items.find((item) => item.id === "vedunya")?.held).toBe(true);
    });

    it("место 3 на таблице не меньше MIN_BOARD — Навий страж навсегда; на малой таблице и место 4 — нет", async () => {
      const top = await account();
      const small = await account();
      const fourth = await account();
      // Закрытый сезон в далёком прошлом: случайный день не пересекается с соседними тестами.
      const key = `2017-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
      await seasonPlace(top, key, 3, 12);
      await seasonPlace(small, key, 1, 8);
      await seasonPlace(fourth, key, 4, 12);

      const heldNavi = async (id: string) => (await appearance.viewFor(id)).items.find((item) => item.id === "navi")?.held;

      expect(await heldNavi(top)).toBe(true);
      expect(await heldNavi(small)).toBe(false);
      expect(await heldNavi(fourth)).toBe(false);
    });

    it("Скоморох недоступен никому", async () => {
      const me = await account();
      await setLevel(me, 100);
      expect((await appearance.viewFor(me)).items.find((item) => item.id === "skomoroh")).toMatchObject({ held: false, source: { kind: "event" } });
    });

    it("каталог в ответе — тот, что в коде, по порядку", async () => {
      const view = await appearance.viewFor(await account());
      expect(view.items.map((item) => item.id)).toEqual(APPEARANCES.map((def) => def.id));
    });
  });

  describe("выбор", () => {
    it("Витязь на уровне 19 — отказ, на 20 — выбран и виден в рейтинге", async () => {
      const me = await account();
      const other = await account();
      await setLevel(me, 19);
      await expect(appearance.choose(me, { id: "vityaz" })).rejects.toBeInstanceOf(AppearanceLockedError);
      expect((await columnsOf(me)).appearance_id).toBeNull();

      await setLevel(me, 20);
      const chosen = await appearance.choose(me, { id: "vityaz" });

      expect(chosen).toMatchObject({ selected: "vityaz", effective: "vityaz" });
      const board = await ratingView([me, other]).leaderboardFor(other, "hard");
      expect(board.entries.find((entry) => !entry.isMe)?.appearance).toBe("vityaz");
      expect(board.entries.find((entry) => entry.isMe)?.appearance).toBe("keeper");
    });

    it("неизвестный id — отказ «нет такого облика»", async () => {
      await expect(appearance.choose(await account(), { id: "dragon" })).rejects.toBeInstanceOf(AppearanceNotFoundError);
    });

    it("чужой облик не выбрать, пока не получен: Скоморох, Князь без VIP, Навий страж без места", async () => {
      const me = await account();
      await setLevel(me, 100);
      for (const id of ["skomoroh", "knyaz", "navi", "ohotnitsa", "vedunya"]) {
        await expect(appearance.choose(me, { id }), id).rejects.toBeInstanceOf(AppearanceLockedError);
      }
      expect((await columnsOf(me)).appearance_id).toBeNull();
    });

    it("Князь при истёкшем VIP: выбор хранится, в строке Хранитель; продлили VIP — снова Князь", async () => {
      const me = await account();
      const other = await account();
      await giveVip(me, new Date(Date.now() - DAY), 30 * 86_400);
      await appearance.choose(me, { id: "knyaz" });
      const shown = async () => (await ratingView([me, other]).leaderboardFor(other, "hard")).entries.find((entry) => !entry.isMe)?.appearance;
      expect(await shown()).toBe("knyaz");

      await expireVip(me);

      expect(await shown()).toBe("keeper");
      expect((await columnsOf(me)).appearance_id).toBe("knyaz");
      expect(await appearance.viewFor(me)).toMatchObject({ selected: "knyaz", effective: "keeper" });

      await giveVip(me, new Date(), 30 * 86_400);

      expect(await shown()).toBe("knyaz");
    });

    it("повтор того же выбора ничего не пишет", async () => {
      const me = await account();
      await setLevel(me, 5);
      await appearance.choose(me, { id: "frost" });
      const spy = vi.spyOn(prisma, "$executeRaw");

      await appearance.choose(me, { id: "frost" });

      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
      expect((await columnsOf(me)).appearance_id).toBe("frost");
    });

    it("avatarPhoto не требует владения и не трогает облик; id без avatarPhoto не трогает аватар", async () => {
      const me = await account();
      await setLevel(me, 5);
      await appearance.choose(me, { id: "frost" });

      await appearance.choose(me, { avatarPhoto: true });
      expect(await columnsOf(me)).toEqual({ appearance_id: "frost", avatar_photo: true });

      await appearance.choose(me, { id: "keeper" });
      expect(await columnsOf(me)).toEqual({ appearance_id: "keeper", avatar_photo: true });

      await appearance.choose(me, { avatarPhoto: false });
      expect(await columnsOf(me)).toEqual({ appearance_id: "keeper", avatar_photo: false });
    });

    it("отказ по облику не записывает и avatarPhoto из того же тела", async () => {
      const me = await account();
      await expect(appearance.choose(me, { id: "vityaz", avatarPhoto: true })).rejects.toBeInstanceOf(AppearanceLockedError);
      expect(await columnsOf(me)).toEqual({ appearance_id: null, avatar_photo: false });
    });
  });

  describe("облик в списках", () => {
    it("avatarPhoto: true виден в строках друзей; без выбора поля в строке нет", async () => {
      const me = await account();
      const friend = await account();
      const plain = await account();
      await friendsRepository.befriend(me, friend, "request", 50);
      await friendsRepository.befriend(me, plain, "request", 50);
      await appearance.choose(friend, { avatarPhoto: true });

      const view = await friendsService().view(me);

      const row = (id: string) => view.friends.find((entry) => entry.accountId === id);
      expect(row(friend)).toMatchObject({ appearance: "keeper", avatarPhoto: true });
      expect(row(plain)).toMatchObject({ appearance: "keeper" });
      expect("avatarPhoto" in (row(plain) ?? {})).toBe(false);
    });

    it("рейтинг и сезон несут облик и аватар того же игрока", async () => {
      const me = await account();
      const other = await account();
      await setLevel(other, 10);
      await appearance.choose(other, { id: "herbalist", avatarPhoto: true });

      const rating = await ratingView([me, other]).leaderboardFor(me, "hard");
      const season = await seasonsView([me, other]).board(me, { difficulty: "hard", scope: "all" }, new Date("2026-11-04T12:00:00Z"));

      for (const entries of [rating.entries, season.entries]) {
        expect(entries.find((entry) => !entry.isMe)).toMatchObject({ appearance: "herbalist", avatarPhoto: true });
      }
    });

    it("строка несёт и знак (T-0235), и облик", async () => {
      const me = await account();
      const other = await account();
      await makeTester(other);
      await setLevel(other, 20);
      await appearance.choose(other, { id: "vityaz" });

      const board = await ratingView([me, other]).leaderboardFor(me, "hard");

      expect(board.entries.find((entry) => !entry.isMe)).toMatchObject({ emblem: { id: "emb_tester" }, appearance: "vityaz" });
    });

    it("сбой источника обликов не убирает знак, сбой источника знаков не убирает облик", async () => {
      const me = await account();
      const other = await account();
      await makeTester(other);
      await setLevel(other, 20);
      await appearance.choose(other, { id: "vityaz" });
      const rowOf = async () => (await ratingView([me, other]).leaderboardFor(me, "hard")).entries.find((entry) => !entry.isMe);

      identity.provide(
        {
          async of() {
            throw new Error("база обликов недоступна");
          },
        },
        IDENTITY_SOURCES.appearance,
      );
      const withoutAppearance = await rowOf();
      expect(withoutAppearance?.emblem?.id).toBe("emb_tester");
      expect(withoutAppearance !== undefined && "appearance" in withoutAppearance).toBe(false);

      identity.provide({ of: async (ids) => await appearance.of(ids) }, IDENTITY_SOURCES.appearance);
      identity.provide(
        {
          async of() {
            throw new Error("база знаков недоступна");
          },
        },
        IDENTITY_SOURCES.emblem,
      );
      const withoutEmblem = await rowOf();
      expect(withoutEmblem?.appearance).toBe("vityaz");
      expect(withoutEmblem !== undefined && "emblem" in withoutEmblem).toBe(false);
    });

    it("на список из 50 аккаунтов — по одному запросу на источник: шесть, а не шесть на строку", async () => {
      const ids: string[] = [];
      for (let index = 0; index < 50; index++) ids.push(await account());
      queries = 0;

      const marks = await appearance.of(ids);

      expect(queries).toBe(6);
      expect(marks.size).toBe(50);
      expect(marks.get(ids[0] ?? "")).toStrictEqual({ appearance: "keeper" });
    });

    it("рейтинг из 50 строк через порт — один вызов источника обликов и шесть запросов", async () => {
      const ids: string[] = [];
      for (let index = 0; index < 50; index++) ids.push(await account());
      const spy = vi.spyOn(appearance, "of");
      queries = 0;

      const board = await ratingView(ids).leaderboardFor(ids[0] ?? "", "hard");

      expect(board.entries).toHaveLength(50);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(queries).toBe(6);
    });

    it("пустой список и не-uuid не ходят в базу; повтор id не удваивает запросы", async () => {
      expect((await appearance.of([])).size).toBe(0);
      expect((await appearance.of(["not-a-uuid", "'; DROP TABLE account; --"])).size).toBe(0);
      expect(queries).toBe(0);

      const me = await account();
      queries = 0;
      expect((await appearance.of([me, me, me])).size).toBe(1);
      expect(queries).toBe(6);
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
        controllers: [AppearanceController],
        providers: [{ provide: APP_CONFIG, useValue: config }, { provide: REDIS, useValue: redis }, { provide: AppearanceService, useValue: appearance }, RateLimiter, AuthGuard],
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
      expect((await http.inject({ method: "GET", url: "/api/v1/appearance" })).statusCode).toBe(401);
      expect((await http.inject({ method: "PUT", url: "/api/v1/appearance", payload: { id: "keeper" } })).statusCode).toBe(401);
    });

    it("GET у новичка: одиннадцать обликов, держится один, avatarPhoto false; форма из задачи", async () => {
      const http = await boot();
      const me = await player();

      const response = await http.inject({ method: "GET", url: "/api/v1/appearance", headers: await headersOf(me) });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: AppearanceView }>().data;
      expect(Object.keys(body).sort()).toEqual(["avatarPhoto", "effective", "items", "selected"]);
      expect(body.avatarPhoto).toBe(false);
      expect(body.items).toHaveLength(11);
      expect(body.items.filter((item) => item.held)).toHaveLength(1);
      expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(["archetype", "held", "id", "rarity", "source"]);
    });

    it("PUT: 409 appearance_locked, 404 appearance_not_found, 400 на пустое тело, 200 на владеемый", async () => {
      const http = await boot();
      const me = await player();
      const headers = await headersOf(me);
      const put = (payload: unknown) => http.inject({ method: "PUT", url: "/api/v1/appearance", headers, payload: payload as never });

      const locked = await put({ id: "vityaz" });
      expect(locked.statusCode).toBe(409);
      expect(locked.json<{ error: { code: string } }>().error.code).toBe("appearance_locked");

      const missing = await put({ id: "dragon" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<{ error: { code: string } }>().error.code).toBe("appearance_not_found");

      expect((await put({})).statusCode).toBe(400);
      expect((await put({ id: 7 })).statusCode).toBe(400);

      await setLevel(me.accountId, 5);
      const ok = await put({ id: "frost", avatarPhoto: true });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ data: unknown }>().data).toMatchObject({ selected: "frost", effective: "frost", avatarPhoto: true });
      const again = await put({ id: "frost", avatarPhoto: true });
      expect(again.statusCode).toBe(200);
    });
  });
});
