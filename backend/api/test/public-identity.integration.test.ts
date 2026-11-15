import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PublicIdentity } from "../src/common/public-identity.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAchievementsRepository } from "../src/modules/achievements/achievements.repository.js";
import { PrismaEmblemsRepository } from "../src/modules/achievements/emblems.repository.js";
import { EmblemsService } from "../src/modules/achievements/emblems.service.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { AuthHooks } from "../src/modules/auth/auth-hooks.js";
import type { FriendNotifier } from "../src/modules/friends/friend-notifier.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { FriendsService } from "../src/modules/friends/friends.service.js";
import type { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
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
import { uniquePlatformUserId } from "./helpers/player-ids.js";

/**
 * Знак у имени в строках рейтинга, сезона и друзей на живых Postgres и Redis
 * (tasks/T-0240, docs/35-stage4-plan.md Р149; адреса — TEST_DATABASE_URL и
 * PLAYTEST_TEST_REDIS_URL, без них пропуск).
 *
 * Источник знаков настоящий — `EmblemsService` над базой, каталог из миграции.
 * Места и подписи рейтинга и сезона подставлены: проверяется, что строка
 * получает знак из живой базы одним вызовом на список, а не порядок мест.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const DAY = 86_400_000;

describe.skipIf(!live)("знак у имени в строках списков на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let friendsRepository: PrismaFriendsRepository;
  let vip: PrismaVipRepository;
  let emblems: EmblemsService;
  let identity: PublicIdentity;
  /** Сколько раз порт позвал источник и с какими списками. */
  let calls: string[][];

  async function account(): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: "Знак в списке", username: null },
      Date.now(),
    );
    return created.accountId;
  }

  async function makeTester(accountId: string): Promise<void> {
    await prisma.$executeRaw`UPDATE account SET tester_at = now() WHERE account_id = ${accountId}::uuid`;
  }

  async function complete(accountId: string, taskId: string): Promise<void> {
    const at = new Date();
    await prisma.$executeRaw`
      INSERT INTO task_progress (account_id, task_id, period_start, value, target, completed_at, updated_at)
      SELECT ${accountId}::uuid, d.task_id, DATE '2000-01-01', d.target, d.target, ${at}, ${at}
      FROM task_def d WHERE d.task_id = ${taskId}
      ON CONFLICT (account_id, task_id, period_start) DO NOTHING`;
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
        telegramChargeId: `pid-${purchaseId}`,
        invoicedAt: paidAt,
        paidAt,
      },
    });
    await vip.addPeriod({ purchaseId, subscriptionId: purchaseId, accountId, paidAt, periodSec, at: paidAt });
  }

  /** Строка лучшего забега без подробностей: нужны имя и метки «Тестер» и «Меценат». */
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
    const rolesStub = { require: async () => undefined, audit: async () => undefined } as unknown as RolesService;
    const wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    const unused = {} as never;
    const tasks = new TasksService(new PrismaTasksRepository(prisma), wallet, new RunsHooks(), rolesStub, unused, unused, unused);
    emblems = new EmblemsService(tasks, new PrismaEmblemsRepository(prisma), new PrismaAchievementsRepository(prisma), panelSettings());
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    calls = [];
    identity = new PublicIdentity();
    identity.provide({
      of: async (ids) => {
        calls.push([...ids]);
        return await emblems.of(ids);
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("строка рейтинга тестера без выбора — emb_tester; поля tester и supporter на месте", async () => {
    const me = await account();
    await makeTester(me);

    const board = await ratingView([me]).leaderboardFor(me, "hard");

    expect(board.entries[0]).toMatchObject({ tester: true, supporter: true, emblem: { id: "emb_tester", category: "status", tier: "rare" } });
  });

  it("выбранный «Последний рубеж» виден в рейтинге, в таблице сезона и у друга", async () => {
    const me = await account();
    const friend = await account();
    await makeTester(friend);
    await complete(friend, "ach_survive_20");
    await emblems.choose(friend, "ach_survive_20");
    await friendsRepository.befriend(me, friend, "request", 50);
    const expected = { id: "ach_survive_20", title: "Последний рубеж", tier: "epic", category: "merit" };

    const rating = await ratingView([me, friend]).leaderboardFor(me, "hard");
    const season = await seasonsView([me, friend]).board(me, { difficulty: "hard", scope: "all" }, new Date("2026-11-04T12:00:00Z"));
    const friends = await friendsService().view(me);

    expect(rating.entries.find((entry) => !entry.isMe)?.emblem).toStrictEqual(expected);
    expect(season.entries.find((entry) => !entry.isMe)?.emblem).toStrictEqual(expected);
    expect(friends.friends[0]?.emblem).toStrictEqual(expected);
    expect(friends.friends[0]).toMatchObject({ tester: true });
  });

  it("VIP истёк — в строке знак по умолчанию, а не выбранный emb_vip", async () => {
    const me = await account();
    const vipPlayer = await account();
    await makeTester(vipPlayer);
    await giveVip(vipPlayer, new Date(Date.now() - DAY), 30 * 86_400);
    await emblems.choose(vipPlayer, "emb_vip");
    const shown = async () => (await ratingView([me, vipPlayer]).leaderboardFor(me, "hard")).entries.find((entry) => !entry.isMe)?.emblem?.id;
    expect(await shown()).toBe("emb_vip");

    await prisma.$executeRaw`UPDATE vip_period SET starts_at = starts_at - interval '60 days', ends_at = now() - interval '1 hour' WHERE account_id = ${vipPlayer}::uuid`;

    expect(await shown()).toBe("emb_tester");
  });

  it("список рейтинга из 50 строк — один вызов источника", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 50; index++) ids.push(await account());

    const board = await ratingView(ids).leaderboardFor(ids[0] ?? "", "hard");

    expect(board.entries).toHaveLength(50);
    expect(calls).toHaveLength(1);
    expect([...(calls[0] ?? [])].sort()).toEqual([...ids].sort());
  });
});
