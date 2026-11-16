import { randomUUID } from "node:crypto";
import { Logger, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { IDENTITY_SOURCES, PublicIdentity, publicIdSchema } from "../src/common/public-identity.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createHttpApp } from "../src/http-app.js";
import { createPrisma } from "../src/infra/database.js";
import { REDIS, closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAchievementsRepository } from "../src/modules/achievements/achievements.repository.js";
import { AchievementsService } from "../src/modules/achievements/achievements.service.js";
import { isVipActive } from "../src/modules/achievements/emblem-rules.js";
import { PrismaEmblemsRepository } from "../src/modules/achievements/emblems.repository.js";
import { EmblemsService } from "../src/modules/achievements/emblems.service.js";
import { PrismaAppearanceRepository } from "../src/modules/appearance/appearance.repository.js";
import { AppearanceService } from "../src/modules/appearance/appearance.service.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { AuthHooks } from "../src/modules/auth/auth-hooks.js";
import { FriendInviteService } from "../src/modules/friends/friend-invite.service.js";
import { FriendsController } from "../src/modules/friends/friends.controller.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { FriendsService } from "../src/modules/friends/friends.service.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PrismaItemsRepository } from "../src/modules/items/items.repository.js";
import { ItemsService, cryptoSeeds } from "../src/modules/items/items.service.js";
import { CARD_LIMIT } from "../src/modules/players/player-card-rules.js";
import { PlayersController } from "../src/modules/players/players.controller.js";
import { PlayersService } from "../src/modules/players/players.service.js";
import { publicIdSource } from "../src/modules/players/public-id-source.js";
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
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Карточка игрока, сервер (tasks/T-0247, docs/35-stage4-plan.md Р47, Р48) на живых Postgres и
 * Redis (адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них пропуск).
 *
 * Память этого не покажет: публичный id — столбец с уникальным индексом и запасным значением в
 * самой базе, карточка собирается из таблиц разных модулей, а лимит считает Redis.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 13);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

describe.skipIf(!live)("карточка игрока на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let friendsRepository: PrismaFriendsRepository;
  let identity: PublicIdentity;
  let players: PlayersService;
  let friends: FriendsService;
  /** Какую доску читает аккаунт: нет в карте — общую. */
  const boards = new Map<string, "full" | "common">();

  async function account(name = "Карточка"): Promise<{ accountId: string; publicId: string }> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(980_000_000 + Math.floor(Math.random() * 15_000_000)), displayName: name, username: null }, Date.now());
    if (created.publicId === undefined) throw new Error("у нового аккаунта нет публичного id");
    return { accountId: created.accountId, publicId: created.publicId };
  }

  async function setLevel(accountId: string, level: number): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO account_progress (account_id, xp, level, updated_at) VALUES (${accountId}::uuid, 0, ${level}, now())
      ON CONFLICT (account_id) DO UPDATE SET level = ${level}`;
  }

  function runRow(accountId: string) {
    return { accountId, runId: randomUUID(), displayName: "Игрок", photoUrl: null, tester: false, supporter: false, points: 90, survivalSec: 100, style: null, level: 3, startingWeaponId: "knife", enemiesKilled: 10 };
  }

  function ratingService(): RunsViewService {
    const runs = {
      bestRuns: async (ids: string[]) => ids.map(runRow),
      stats: async () => ({ runs: 12, totalKills: 3_400, totalSurvivalSec: 5_000 }),
      bestRunOf: async () => ({ ...runRow("x"), survivalSec: 640, points: 900 }),
    } as unknown as RunsRepository;
    const store = {
      top: async (_d: string, _n: number, board: string) => [...boardMembers(board)].map((accountId, index) => ({ accountId, score: 1_000 - index })),
      count: async () => 0,
      rank: async () => 4,
      best: async () => 900,
    } as unknown as LeaderboardStore;
    const rating = { boardOf: async (id: string) => boards.get(id) ?? "common", hold: async () => null, since: () => null } as unknown as RatingRestrictions;
    return new RunsViewService(runs, store, new RunExtras(), rating, new RunPrestige(), undefined, identity);
  }

  const onBoard = new Set<string>();
  function boardMembers(board: string): Set<string> {
    return board === "full" ? onBoard : new Set([...onBoard].filter((id) => boards.get(id) !== "full"));
  }

  function seasonsService(): SeasonsViewService {
    const schedule = new SeasonSchedule(panelSettings({ [SETTINGS.seasonsStartDate.key]: 20261102 }));
    const store = {
      top: async (_k: string, _d: string, _n: number, board: string) => [...boardMembers(board)].map((accountId, index) => ({ accountId, score: 1_000 - index })),
      count: async () => onBoard.size,
      rank: async () => 3,
      best: async () => 1_000,
    } as unknown as SeasonBoardStore;
    const repository = { boardRuns: async (ids: string[]) => ids.map(runRow) } as unknown as SeasonsRepository;
    const rating = { boardOf: async (id: string) => boards.get(id) ?? "common" };
    return new SeasonsViewService(schedule, repository, store, {} as never, { status: async () => null } as never, rating as never, identity);
  }

  function friendsService(): FriendsService {
    const notifier = { requestSent: async () => undefined } as never;
    const notifications = { readFor: async () => undefined, post: () => undefined } as never;
    return new FriendsService(config, friendsRepository, accounts, new AuthHooks(), {} as unknown as WalletService, notifier, notifications, {} as never, identity);
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    friendsRepository = new PrismaFriendsRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    boards.clear();
    onBoard.clear();
    identity = new PublicIdentity();
    const unused = {} as never;
    const rolesStub = { require: async () => undefined, audit: async () => undefined } as unknown as RolesService;
    const wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    const tasks = new TasksService(new PrismaTasksRepository(prisma), wallet, new RunsHooks(), rolesStub, unused, unused, unused);
    const emblemsRepository = new PrismaEmblemsRepository(prisma);
    const emblems = new EmblemsService(tasks, emblemsRepository, new PrismaAchievementsRepository(prisma), panelSettings());
    const appearance = new AppearanceService(tasks, new PrismaAppearanceRepository(prisma), emblemsRepository);
    identity.provide({ of: async (ids) => await emblems.of(ids) }, IDENTITY_SOURCES.emblem);
    identity.provide({ of: async (ids) => await appearance.of(ids) }, IDENTITY_SOURCES.appearance);
    identity.provide(publicIdSource(accounts), IDENTITY_SOURCES.publicId);
    friends = friendsService();
    const achievements = new AchievementsService(tasks, new PrismaAchievementsRepository(prisma), friends, { view: async () => ({ level: 1 }) }, panelSettings(), emblems);
    const items = new ItemsService(new PrismaItemsRepository(prisma), unused, config, cryptoSeeds, unused);
    const rating = { boardOf: async (id: string) => boards.get(id) ?? "common" } as unknown as RatingRestrictions;
    players = new PlayersService({
      accounts,
      friends: friendsRepository,
      rating,
      runs: ratingService(),
      seasons: seasonsService(),
      progress: { view: async (id: string) => ({ level: await levelOf(id) }) },
      items,
      achievements,
      emblems,
      vip: { activeAt: async (id: string, at: Date) => isVipActive((await emblemsRepository.vipUntil([id])).get(id) ?? null, at) },
      identity,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function levelOf(accountId: string): Promise<number> {
    const [row] = await prisma.$queryRaw<{ level: number }[]>`SELECT level FROM account_progress WHERE account_id = ${accountId}::uuid`;
    return row?.level ?? 1;
  }

  describe("публичный id в базе", () => {
    it("у каждого аккаунта он есть: двенадцать hex-знаков, и все разные", async () => {
      await account();
      const [row] = await prisma.$queryRaw<{ total: bigint; bad: bigint; distinct: bigint }[]>`
        SELECT count(*) AS total,
               count(*) FILTER (WHERE public_id IS NULL OR public_id !~ '^[0-9a-f]{12}$') AS bad,
               count(DISTINCT public_id) AS distinct
        FROM account`;
      expect(Number(row?.bad)).toBe(0);
      expect(Number(row?.distinct)).toBe(Number(row?.total));
    });

    it("уникальность держит индекс, а столбец не принимает пустое", async () => {
      const [index] = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE tablename = 'account' AND indexdef ILIKE '%public_id%'`;
      expect(index?.indexdef).toMatch(/UNIQUE/i);
      const [column] = await prisma.$queryRaw<{ is_nullable: string }[]>`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'account' AND column_name = 'public_id'`;
      expect(column?.is_nullable).toBe("NO");
    });

    it("аккаунт, заведённый мимо репозитория (старый код, тесты), получает id от базы", async () => {
      const accountId = randomUUID();
      await prisma.account.create({ data: { accountId, platform: "telegram", platformUserId: `pc-${accountId.slice(0, 12)}`, displayName: "Мимо" } });
      const found = await accounts.byId(accountId);
      expect(publicIdSchema.safeParse(found?.publicId).success).toBe(true);
    });

    it("повторный вход не меняет id; по нему аккаунт находится", async () => {
      const me = await account();
      const again = await accounts.upsert({ platform: "telegram", platformUserId: (await accounts.byId(me.accountId))?.platformUserId ?? "", displayName: "Другое имя", username: null }, Date.now());
      expect(again.publicId).toBe(me.publicId);
      expect((await accounts.byPublicId(me.publicId))?.accountId).toBe(me.accountId);
      expect(await accounts.byPublicId("000000000000")).toBeNull();
    });

    it("коллизия id при создании — новая попытка, до трёх; на четвёртой ошибка", async () => {
      const taken = await account();
      const offered = [taken.publicId, taken.publicId, "abcdefabcdef"];
      const retrying = new PrismaAccountRepository(prisma, undefined, undefined, () => offered.shift() ?? taken.publicId);
      const created = await retrying.upsert({ platform: "telegram", platformUserId: String(990_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "Третья попытка", username: null }, Date.now());
      expect(created.publicId).toBe("abcdefabcdef");
      await prisma.account.deleteMany({ where: { publicId: "abcdefabcdef" } });

      const stubborn = new PrismaAccountRepository(prisma, undefined, undefined, () => taken.publicId);
      await expect(stubborn.upsert({ platform: "telegram", platformUserId: String(991_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "Не вышло", username: null }, Date.now())).rejects.toThrow();
    });

    it("пачка id — один запрос на любое число аккаунтов", async () => {
      const [a, b] = [await account(), await account()];
      const found = await accounts.publicIds([a.accountId, b.accountId, a.accountId]);
      expect(found.get(a.accountId)).toBe(a.publicId);
      expect(found.get(b.accountId)).toBe(b.publicId);
      expect((await accounts.publicIds([])).size).toBe(0);
    });
  });

  describe("списки несут публичный id и не несут внутренний", () => {
    it("рейтинг и таблица сезона", async () => {
      const [me, other] = [await account("Я"), await account("Он")];
      onBoard.add(me.accountId);
      onBoard.add(other.accountId);

      const board = await ratingService().leaderboardFor(me.accountId, "hard");
      const season = await seasonsService().board(me.accountId, { difficulty: "hard", scope: "all" });

      for (const view of [board.entries, season.entries]) {
        const text = JSON.stringify(view);
        expect(view.find((entry) => !entry.isMe)?.publicId).toBe(other.publicId);
        expect(view.find((entry) => entry.isMe)?.publicId).toBe(me.publicId);
        expect(text).not.toContain(other.accountId);
        expect(text).not.toContain(me.accountId);
        expect(text).not.toContain("accountId");
      }
    });

    it("друзья, входящие и исходящие заявки", async () => {
      const [me, pal, incoming, outgoing] = [await account(), await account(), await account(), await account()];
      await friendsRepository.befriend(me.accountId, pal.accountId, "request", 100);
      await friendsRepository.request(incoming.accountId, me.accountId, { maxIncoming: 50, maxOutgoing: 50 });
      await friendsRepository.request(me.accountId, outgoing.accountId, { maxIncoming: 50, maxOutgoing: 50 });

      const view = await friends.view(me.accountId);

      expect(view.friends.map((row) => row.publicId)).toEqual([pal.publicId]);
      expect(view.incoming.map((row) => row.publicId)).toEqual([incoming.publicId]);
      expect(view.outgoing.map((row) => row.publicId)).toEqual([outgoing.publicId]);
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
        controllers: [PlayersController, FriendsController],
        providers: [
          { provide: APP_CONFIG, useValue: config },
          { provide: REDIS, useValue: redis },
          { provide: PlayersService, useValue: players },
          { provide: FriendsService, useValue: friends },
          { provide: FriendInviteService, useValue: {} },
          RateLimiter,
          AuthGuard,
        ],
      })
      class TestModule {}
      const created = await createHttpApp(TestModule, { logger: false });
      await created.init();
      await created.getHttpAdapter().getInstance().ready();
      app = created;
      return created;
    }

    async function headersOf(accountId: string): Promise<Record<string, string>> {
      const found = await accounts.byId(accountId);
      const token = await signAccessToken({ accountId, platform: "telegram", platformUserId: found?.platformUserId ?? "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
      return { authorization: `Bearer ${token}` };
    }

    it("без токена — 401", async () => {
      const http = await boot();
      expect((await http.inject({ method: "GET", url: "/api/v1/players/a1b2c3d4e5f6" })).statusCode).toBe(401);
    });

    it("карточка: облик, знак, уровень, мощь, числа, витрина; внутренних id нет", async () => {
      const http = await boot();
      const [me, target] = [await account("Смотрящий"), await account("Стрелок")];
      await setLevel(target.accountId, 9);
      await prisma.$executeRaw`UPDATE account SET tester_at = now() WHERE account_id = ${target.accountId}::uuid`;

      const response = await http.inject({ method: "GET", url: `/api/v1/players/${target.publicId}`, headers: await headersOf(me.accountId) });

      expect(response.statusCode).toBe(200);
      const card = response.json<{ data: Record<string, unknown> }>().data;
      expect(card).toMatchObject({ publicId: target.publicId, name: "Стрелок", appearance: "keeper", level: 9, power: 0, relation: "none", season: { place: 3 }, stats: { runs: 12, totalKills: 3400, bestSurvivalSec: 640 }, prestige: 0, favorites: [] });
      expect(card.emblem).toMatchObject({ id: "emb_tester" });
      expect(card.emblems).toMatchObject({ held: 1 });
      expect(JSON.stringify(card)).not.toContain(target.accountId);
      expect(JSON.stringify(card)).not.toContain("platformUserId");
    });

    it("своя карточка — relation self; друг — friend", async () => {
      const http = await boot();
      const [me, pal] = [await account(), await account()];
      await friendsRepository.befriend(me.accountId, pal.accountId, "request", 100);
      const headers = await headersOf(me.accountId);

      const own = await http.inject({ method: "GET", url: `/api/v1/players/${me.publicId}`, headers });
      const friend = await http.inject({ method: "GET", url: `/api/v1/players/${pal.publicId}`, headers });

      expect(own.json<{ data: { relation: string } }>().data.relation).toBe("self");
      expect(friend.json<{ data: { relation: string } }>().data.relation).toBe("friend");
    });

    it("несуществующий и скрытый правилом доски — один и тот же 404 player_not_found", async () => {
      const http = await boot();
      const [me, hidden] = [await account(), await account()];
      boards.set(hidden.accountId, "full");
      const headers = await headersOf(me.accountId);

      const missing = await http.inject({ method: "GET", url: "/api/v1/players/ffffffffffff", headers });
      const separate = await http.inject({ method: "GET", url: `/api/v1/players/${hidden.publicId}`, headers });

      expect(missing.statusCode).toBe(404);
      expect(separate.statusCode).toBe(404);
      const stripped = (body: { error: Record<string, unknown> }) => ({ ...body.error, requestId: undefined });
      expect(stripped(separate.json())).toEqual(stripped(missing.json()));
      expect(separate.json<{ error: { code: string } }>().error.code).toBe("player_not_found");
      // смотрящий с полной доской его видит
      boards.set(me.accountId, "full");
      expect((await http.inject({ method: "GET", url: `/api/v1/players/${hidden.publicId}`, headers })).statusCode).toBe(200);
    });

    it("плохой публичный id — 400", async () => {
      const http = await boot();
      const me = await account();
      const headers = await headersOf(me.accountId);
      for (const bad of ["A1B2C3D4E5F6", "a1b2c3d4e5f", "a1b2c3d4e5f67"]) {
        expect((await http.inject({ method: "GET", url: `/api/v1/players/${bad}`, headers })).statusCode).toBe(400);
      }
    });

    it("61-я карточка за минуту — 429", async () => {
      const http = await boot();
      const me = await account();
      const headers = await headersOf(me.accountId);
      let last = 0;
      for (let i = 0; i < CARD_LIMIT.limit; i += 1) last = (await http.inject({ method: "GET", url: `/api/v1/players/${me.publicId}`, headers })).statusCode;
      expect(last).toBe(200);
      expect((await http.inject({ method: "GET", url: `/api/v1/players/${me.publicId}`, headers })).statusCode).toBe(429);
    });

    it("заявка в друзья по публичному id: заявка, повтор тихий, оба поля — 400", async () => {
      const http = await boot();
      const [me, target] = [await account(), await account()];
      const headers = await headersOf(me.accountId);
      const post = (payload: unknown) => http.inject({ method: "POST", url: "/api/v1/friends/requests", headers, payload: payload as never });

      const first = await post({ publicId: target.publicId });
      const again = await post({ publicId: target.publicId });
      const both = await post({ publicId: target.publicId, accountId: target.accountId });
      const nothing = await post({});

      expect(first.statusCode).toBe(201);
      expect(first.json<{ data: { status: string } }>().data.status).toBe("requested");
      expect(again.json<{ data: { status: string } }>().data.status).toBe("requested");
      expect(both.statusCode).toBe(400);
      expect(nothing.statusCode).toBe(400);
      expect(await friendsRepository.hasRequest(me.accountId, target.accountId)).toBe(true);
      expect((await friends.view(me.accountId)).outgoing).toHaveLength(1);
    });

    it("заявка по публичному id: себе — 400, несуществующему — 404, чужой площадки — 404", async () => {
      const http = await boot();
      const me = await account();
      const headers = await headersOf(me.accountId);
      const post = (payload: unknown) => http.inject({ method: "POST", url: "/api/v1/friends/requests", headers, payload: payload as never });

      expect((await post({ publicId: me.publicId })).statusCode).toBe(400);
      expect((await post({ publicId: "ffffffffffff" })).statusCode).toBe(404);
      const other = await accounts.upsert({ platform: "max", platformUserId: String(992_000_000 + Math.floor(Math.random() * 9_000_000)), displayName: "С другой площадки", username: null }, Date.now());
      expect((await post({ publicId: other.publicId })).statusCode).toBe(404);
    });
  });
});
