import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { bundledExpectedTable, expectedRowOf, type ExpectedTable } from "../src/modules/rating/expected-table.js";
import type { RunScorer } from "../src/modules/rating/run-scorer.service.js";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { runFinishSchema, type RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RedisLeaderboardStore } from "../src/modules/runs/leaderboard.store.js";
import { rebuildLeaderboard } from "../src/modules/runs/leaderboard-rebuild.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { DIFFICULTIES } from "../src/modules/runs/run-rules.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { PrismaRunsRepository, type RunFinishRecord } from "../src/modules/runs/runs.repository.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { RedisSeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { THRESHOLD_REWARD, seasonOf, type Season } from "../src/modules/seasons/season-rules.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonsCloseService } from "../src/modules/seasons/seasons-close.service.js";
import { PrismaSeasonCloseRepository } from "../src/modules/seasons/seasons-close.repository.js";
import { SeasonsProjection } from "../src/modules/seasons/seasons-projection.js";
import { PrismaSeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import { SeasonsViewService } from "../src/modules/seasons/seasons-view.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { ratingRestrictions } from "./helpers/memory-runs.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Доски рейтинга по очкам на настоящих Postgres и Redis (tasks/T-0294). Адреса —
 * TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них файл пропускается.
 *
 * Память не покажет главного: что лучший забег периода выбирает база по `points`,
 * а не по времени, что сезон до понедельника перехода и сезон после него лежат в
 * Redis под разными ключами и что закрытие сезона берёт порог награды из очков.
 *
 * Забеги принимает настоящий `RunsService`; очки в нём считает заглушка «очки =
 * убийства × 6»: так тест сам задаёт и очки, и время забега, не подбирая числа
 * под настоящие правила (они проверены в `rating-score.test.ts`).
 *
 * Недели берутся из далёкого будущего: база общая для всех прогонов, и закрытый
 * сезон прошлого прогона не должен мешать этому.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 12);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FIRST_MONDAY = Date.UTC(2046, 0, 1);
const START_KEY = "seasons.start-date";
const POINTS_FROM_KEY = "rating.points-from";

/** Понедельник как число настройки: 20461102. */
function settingOf(monday: Date): number {
  return Number(monday.toISOString().slice(0, 10).replaceAll("-", ""));
}

/** Очки заглушки: убийства × 6. Забег на 300 убийств — 1 800 очков. */
const POINTS_PER_KILL = 6;

/** Подсчёт очков, в котором очки забега задаёт тест, а не правила рейтинга. */
function killsScorer(): RunScorer {
  const scorer: Pick<RunScorer, "score" | "announce" | "expectedPointsFor"> = {
    score: (input) => ({ points: input.enemiesKilled * POINTS_PER_KILL, axes: { t: 1, k: 1, h: 1, c: 1, b: 1 }, style: "k", band: "average", expectedPoints: 0, outOfRange: false }),
    announce: async () => {},
    expectedPointsFor: () => 0,
  };
  return scorer as RunScorer;
}

describe.skipIf(!live)("доски рейтинга по очкам на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let runs: PrismaRunsRepository;
  let friends: PrismaFriendsRepository;
  let leaderboard: RedisLeaderboardStore;
  let seasonStore: RedisSeasonBoardStore;
  let seasonsRepository: PrismaSeasonsRepository;
  let closeRepository: PrismaSeasonCloseRepository;
  let table: ExpectedTable;
  const memoryAccounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    // Недели далёкого будущего принадлежат только этому файлу: остатки прошлых прогонов не копятся.
    await prisma.$executeRaw`DELETE FROM season WHERE starts_at >= '2046-01-01'`;
    await prisma.$executeRaw`DELETE FROM run WHERE finished_at >= '2046-01-01'`;
    accounts = new PrismaAccountRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    friends = new PrismaFriendsRepository(prisma);
    leaderboard = new RedisLeaderboardStore(redis);
    seasonStore = new RedisSeasonBoardStore(redis);
    seasonsRepository = new PrismaSeasonsRepository(prisma);
    closeRepository = new PrismaSeasonCloseRepository(prisma);
    const bundled = bundledExpectedTable();
    if (bundled === null) throw new Error("таблица ожидаемого не разобралась");
    table = bundled;
  });

  beforeEach(async () => {
    // Доска всех времён одна на файл: каждый тест начинает с пустой, как с чистой пересборки.
    const keys = DIFFICULTIES.flatMap((difficulty) => [`runs:leaderboard:pts:${difficulty}`, `runs:leaderboard:pts:full:${difficulty}`, `lb:rubezh:${difficulty}`]);
    await redis.del(...keys);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  async function player(name = "Игрок"): Promise<AccountRef> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(500_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: name, username: null, photoUrl: null }, Date.now());
    return { accountId: created.accountId, platform: "telegram", platformUserId: created.platformUserId };
  }

  async function moderator(): Promise<AccountRef> {
    const created = await memoryAccounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)), displayName: "Модератор", username: null, photoUrl: null }, Date.now());
    await rolesRepository.grant(created.accountId, "owner", null);
    return { accountId: created.accountId, platform: "telegram", platformUserId: created.platformUserId };
  }

  /** Недели, уже выданные тестам этого прогона. */
  const handedOut = new Set<string>();

  /** Неделя далёкого будущего (и `weeks - 1` следующих), на которой нет ни сезона, ни забегов, ни таблиц в Redis. */
  async function freeWeek(weeks = 1): Promise<Season> {
    for (;;) {
      const season = seasonOf(new Date(FIRST_MONDAY + (1_000 + Math.floor(Math.random() * 1_400)) * 7 * DAY));
      const until = new Date(season.startsAt.getTime() + weeks * 7 * DAY);
      const keys = Array.from({ length: weeks }, (_, index) => seasonOf(new Date(season.startsAt.getTime() + index * 7 * DAY)).key);
      if (keys.some((key) => handedOut.has(key))) continue;
      const taken = (await prisma.season.count({ where: { startsAt: { gte: season.startsAt, lt: until } } })) + (await prisma.run.count({ where: { finishedAt: { gte: season.startsAt, lt: until } } }));
      if (taken > 0) continue;
      const boards = keys.flatMap((key) => DIFFICULTIES.flatMap((difficulty) => [`seasons:${key}:${difficulty}`, `seasons:pts:${key}:${difficulty}`]));
      if ((await redis.exists(...boards)) > 0) continue;
      for (const key of keys) handedOut.add(key);
      return season;
    }
  }

  /** Мир теста: те же модули, что в проде, на настоящих базах; сезоны идут с `start`, по очкам — с `pointsFrom`. */
  function world(start: Date, pointsFrom: Date | null) {
    const settings = panelSettings({ [START_KEY]: settingOf(start), ...(pointsFrom === null ? {} : { [POINTS_FROM_KEY]: settingOf(pointsFrom) }) });
    const schedule = new SeasonSchedule(settings);
    const hooks = new RunsHooks();
    const rating = ratingRestrictions(runs, leaderboard, undefined, settings);
    const roles = new RolesService(config, rolesRepository, memoryAccounts);
    const service = new RunsService(config, runs, leaderboard, roles, hooks, new RunContinues(), new RunLoadouts(), rating.rating, undefined, killsScorer());
    const projection = new SeasonsProjection(schedule, seasonStore, seasonsRepository, hooks, new RestrictionsHooks(), rating.gate, rating.rating);
    projection.onModuleInit();
    const seasonsView = new SeasonsViewService(schedule, seasonsRepository, seasonStore, friends, rating.gate, rating.rating);
    const close = new SeasonsCloseService(redis, schedule, closeRepository, rating.gate);
    const view = new RunsViewService(runs, leaderboard, new RunExtras(), rating.rating, new RunPrestige());
    return { schedule, hooks, rating, service, projection, seasonsView, close, view };
  }

  /** Итог по ожидаемому на десятой минуте полосы `average`: время и убийства задаёт тест, остальное правдоподобно. */
  function finish(survivalSec: number, kills: number, patch: Partial<RunFinish> = {}): RunFinish {
    const row = expectedRowOf(table, "average", 10);
    return runFinishSchema.parse({
      runId: randomUUID(),
      difficultyId: "hard",
      outcome: "died",
      survivalSec,
      level: 18,
      enemiesKilled: kills,
      startingWeaponId: "knife",
      weapons: [{ id: "knife", level: 2 }],
      contentHash: table.contentHash,
      stats: {
        damageTaken: Math.round(row.damageTakenPerMin * 10),
        xpCollected: 100,
        waveReached: 10,
        topKills: [],
        huntLog: [{ rank: "elite", value: row.huntPerMin * 10, aliveSec: row.huntKillSec.elite }],
        buildScore: row.buildScore,
        power: 2.2,
      },
      ...patch,
    });
  }

  /** Сдать забег в момент `at` и дождаться, пока недельная таблица его учтёт (слушатели идут без ожидания). */
  async function play(w: ReturnType<typeof world>, who: AccountRef, at: Date, survivalSec: number, kills: number) {
    const run = finish(survivalSec, kills);
    const result = await w.service.finish(who, run, at.getTime());
    expect(result.verdict).toBe("ok");
    expect(result.recorded).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { run, result };
  }

  /** Забег записан прямо в базу — с очками или без, как до их подсчёта. */
  async function save(accountId: string, at: Date, survivalSec: number, points: number | null): Promise<RunFinishRecord> {
    const record: RunFinishRecord = {
      runId: randomUUID(),
      accountId,
      difficulty: "hard",
      startingWeaponId: "knife",
      contentHash: "abc",
      finishedAt: at,
      outcome: "died",
      survivalSec,
      level: 6,
      enemiesKilled: 300,
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
      score: points === null ? null : { points, axes: { t: 1, k: 1, h: 1, c: 1, b: 1 }, style: "k", band: "average" },
    };
    expect(await runs.finish(record)).toBe("finished");
    return record;
  }

  describe("лучший забег периода — по очкам, время подписью", () => {
    it("два забега игрока: 900 с и 1 800 очков, 1 200 с и 1 500 очков — в доске 1 800, подпись 900 с", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt, week.startsAt);
      const me = await player();

      await play(w, me, new Date(week.startsAt.getTime() + HOUR), 900, 300);
      await play(w, me, new Date(week.startsAt.getTime() + 2 * HOUR), 1_200, 250);

      // Вечная доска.
      const all = await w.view.leaderboardFor(me.accountId, "hard");
      expect(all.me).toMatchObject({ points: 1_800, survivalSec: 900 });
      const own = all.entries.find((entry) => entry.isMe);
      expect(own).toMatchObject({ points: 1_800, survivalSec: 900, style: "k" });
      // Недельная доска: под ключом сезона по очкам, а не под прежним.
      expect(await redis.exists(`seasons:pts:${week.key}:hard`)).toBe(1);
      expect(await redis.exists(`seasons:${week.key}:hard`)).toBe(0);
      const board = await w.seasonsView.board(me.accountId, { difficulty: "hard", scope: "all" }, new Date(week.startsAt.getTime() + 3 * HOUR));
      expect(board).toMatchObject({ seasonKey: week.key, scoring: "points", total: 1 });
      expect(board.entries[0]).toMatchObject({ points: 1_800, survivalSec: 900, style: "k", isMe: true });
      expect(board.me).toMatchObject({ rank: 1, points: 1_800, survivalSec: 900, style: "k" });
    });

    it("ответ несёт и points, и survivalSec: старые клиенты читают время, новые — очки", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt, week.startsAt);
      const me = await player();
      await play(w, me, new Date(week.startsAt.getTime() + HOUR), 700, 200);

      const all = await w.view.leaderboardFor(me.accountId, "hard");
      const profile = await w.view.profile(me.accountId);
      const overview = await w.seasonsView.overview(me.accountId, new Date(week.startsAt.getTime() + 2 * HOUR));

      expect(all.me).toEqual({ rank: expect.any(Number), points: 1_200, survivalSec: 700, style: "k" });
      expect(profile.best.hard).toEqual({ points: 1_200, survivalSec: 700, style: "k", rank: expect.any(Number) });
      expect(overview.scoring).toBe("points");
      expect(overview.mine.hard).toBe(700);
      expect(overview.minePoints.hard).toBe(1_200);
      expect(overview.thresholdPoints).toBe(800);
    });
  });

  describe("переход: идущий сезон — по времени, следующий — по очкам", () => {
    it("сезон до rating.points-from лежит под прежним ключом и ранжируется по времени, с понедельника перехода — под pts: по очкам", async () => {
      const before = await freeWeek(2);
      const next = seasonOf(new Date(before.endsAt.getTime() + HOUR));
      const w = world(before.startsAt, next.startsAt);
      const me = await player();

      await play(w, me, new Date(before.startsAt.getTime() + HOUR), 900, 300);
      await play(w, me, new Date(before.startsAt.getTime() + 2 * HOUR), 1_200, 250);
      await play(w, me, new Date(next.startsAt.getTime() + HOUR), 900, 300);
      await play(w, me, new Date(next.startsAt.getTime() + 2 * HOUR), 1_200, 250);

      expect(w.schedule.scoringOf(before)).toBe("time");
      expect(w.schedule.scoringOf(next)).toBe("points");
      expect(await redis.zscore(`seasons:${before.key}:hard`, me.accountId)).toBe("1200");
      expect(await redis.zscore(`seasons:pts:${next.key}:hard`, me.accountId)).toBe("1800");
      expect(await redis.exists(`seasons:pts:${before.key}:hard`)).toBe(0);
      expect(await redis.exists(`seasons:${next.key}:hard`)).toBe(0);

      const old = await w.seasonsView.board(me.accountId, { difficulty: "hard", scope: "all" }, new Date(before.startsAt.getTime() + 3 * HOUR));
      expect(old.scoring).toBe("time");
      // По времени главное число — секунды, поэтому в доске 1 200 с, а очки той же строки — подпись.
      expect(old.entries[0]).toMatchObject({ survivalSec: 1_200, points: 1_500 });
      const fresh = await w.seasonsView.board(me.accountId, { difficulty: "hard", scope: "all" }, new Date(next.startsAt.getTime() + 3 * HOUR));
      expect(fresh.scoring).toBe("points");
      expect(fresh.entries[0]).toMatchObject({ points: 1_800, survivalSec: 900 });
    });

    it("пересборка недели берёт режим сезона: сезон по очкам — очки, по времени — секунды", async () => {
      const before = await freeWeek(2);
      const next = seasonOf(new Date(before.endsAt.getTime() + HOUR));
      const w = world(before.startsAt, next.startsAt);
      const me = await player();
      await save(me.accountId, new Date(before.startsAt.getTime() + HOUR), 900, 1_800);
      await save(me.accountId, new Date(before.startsAt.getTime() + 2 * HOUR), 1_200, 1_500);
      await save(me.accountId, new Date(next.startsAt.getTime() + HOUR), 900, 1_800);
      await save(me.accountId, new Date(next.startsAt.getTime() + 2 * HOUR), 1_200, 1_500);

      await w.projection.rebuild(new Date(before.startsAt.getTime() + 3 * HOUR));
      await w.projection.rebuild(new Date(next.startsAt.getTime() + 3 * HOUR));

      expect(await redis.zscore(`seasons:${before.key}:hard`, me.accountId)).toBe("1200");
      expect(await redis.zscore(`seasons:pts:${next.key}:hard`, me.accountId)).toBe("1800");
    });
  });

  describe("общая доска всех времён", () => {
    it("после пересборки — по очкам лучшего забега; забег без очков в доске не стоит", async () => {
      const slow = await player("Долгий");
      const sharp = await player("Меткий");
      const unscored = await player("Без очков");
      const at = new Date(Date.UTC(2046, 5, 1));
      // Долгий живёт дольше, но очков у него меньше; у третьего забег до подсчёта очков.
      await save(slow.accountId, at, 1_500, 1_100);
      await save(sharp.accountId, at, 600, 2_400);
      await save(unscored.accountId, at, 3_000, null);
      const w = world(new Date(FIRST_MONDAY), null);

      await rebuildLeaderboard(runs, leaderboard, new Set(), new Set(), null);

      const top = await leaderboard.top("hard", 10_000, "common");
      const order = top.map((entry) => entry.accountId).filter((id) => [slow.accountId, sharp.accountId, unscored.accountId].includes(id));
      expect(order).toEqual([sharp.accountId, slow.accountId]);
      expect(await leaderboard.best("hard", sharp.accountId, "common")).toBe(2_400);
      expect(await leaderboard.best("hard", unscored.accountId, "common")).toBeNull();
      const view = await w.view.leaderboardFor(slow.accountId, "hard");
      expect(view.entries.find((entry) => entry.isMe)).toMatchObject({ points: 1_100, survivalSec: 1_500 });
      expect(await redis.exists("runs:leaderboard:hard")).toBe(0);
    });
  });

  describe("снятие забега модератором", () => {
    it("снят лучший по очкам — в досках лучший из оставшихся, и вечной, и недельной", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt, week.startsAt);
      const me = await player();
      const actor = await moderator();
      const best = await play(w, me, new Date(week.startsAt.getTime() + HOUR), 900, 300);
      await play(w, me, new Date(week.startsAt.getTime() + 2 * HOUR), 1_200, 250);
      expect(await leaderboard.best("hard", me.accountId, "common")).toBe(1_800);

      await w.service.setRanked(actor, best.run.runId, false, "сомнительный забег");
      // Слушатель недели считает сезон по часам сервера, а сезон теста в далёком будущем: пересчёт зовётся на момент недели.
      await w.projection.refresh(me.accountId, "hard", new Date(week.startsAt.getTime() + 3 * HOUR));
      expect(await redis.zscore(`seasons:pts:${week.key}:hard`, me.accountId)).toBe("1500");

      expect(await leaderboard.best("hard", me.accountId, "common")).toBe(1_500);
      expect(await leaderboard.best("hard", me.accountId, "full")).toBe(1_500);
      const all = await w.view.leaderboardFor(me.accountId, "hard");
      expect(all.me).toMatchObject({ points: 1_500, survivalSec: 1_200 });
    });

    it("снят единственный забег — игрока в досках нет", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt, week.startsAt);
      const me = await player();
      const actor = await moderator();
      const only = await play(w, me, new Date(week.startsAt.getTime() + HOUR), 900, 300);

      await w.service.setRanked(actor, only.run.runId, false, "сомнительный забег");
      await w.projection.refresh(me.accountId, "hard", new Date(week.startsAt.getTime() + 3 * HOUR));
      expect(await redis.zscore(`seasons:pts:${week.key}:hard`, me.accountId)).toBeNull();

      expect(await leaderboard.best("hard", me.accountId, "common")).toBeNull();
    });
  });

  describe("скрытая доска и друзья", () => {
    it("отдельная доска: обычный игрок её не видит, она себя видит среди всех — всё по очкам", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt, week.startsAt);
      const ordinary = await player("Обычный");
      const hidden = await player("Скрытый");
      w.rating.restrictions.restrict(hidden.accountId, "separate_board", { notify: false });

      await play(w, ordinary, new Date(week.startsAt.getTime() + HOUR), 900, 300);
      await play(w, hidden, new Date(week.startsAt.getTime() + 2 * HOUR), 600, 400);
      const at = new Date(week.startsAt.getTime() + 3 * HOUR);

      const seenByOrdinary = await w.view.leaderboardFor(ordinary.accountId, "hard");
      const seenByHidden = await w.view.leaderboardFor(hidden.accountId, "hard");
      expect(seenByOrdinary.entries.map((entry) => entry.name)).toEqual(["Обычный"]);
      expect(seenByHidden.entries.map((entry) => [entry.name, entry.points])).toEqual([
        ["Скрытый", 2_400],
        ["Обычный", 1_800],
      ]);
      const weekOrdinary = await w.seasonsView.board(ordinary.accountId, { difficulty: "hard", scope: "all" }, at);
      const weekHidden = await w.seasonsView.board(hidden.accountId, { difficulty: "hard", scope: "all" }, at);
      expect(weekOrdinary.entries.map((entry) => entry.name)).toEqual(["Обычный"]);
      expect(weekHidden.entries.map((entry) => [entry.name, entry.points, entry.survivalSec])).toEqual([
        ["Скрытый", 2_400, 600],
        ["Обычный", 1_800, 900],
      ]);
    });

    it("таблица друзей — по очкам, с подписью времени; друг с отдельной доской виден другу", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt, week.startsAt);
      const me = await player("Я");
      const friend = await player("Друг");
      const stranger = await player("Чужой");
      w.rating.restrictions.restrict(friend.accountId, "separate_board", { notify: false });
      expect((await friends.befriend(me.accountId, friend.accountId, "request", 100)).outcome).toBe("added");

      await play(w, me, new Date(week.startsAt.getTime() + HOUR), 900, 300);
      await play(w, friend, new Date(week.startsAt.getTime() + 2 * HOUR), 400, 400);
      await play(w, stranger, new Date(week.startsAt.getTime() + 3 * HOUR), 1_500, 100);

      const board = await w.seasonsView.board(me.accountId, { difficulty: "hard", scope: "friends" }, new Date(week.startsAt.getTime() + 4 * HOUR));

      // Друг играл вдвое короче, но очков у него больше: по очкам он первый.
      expect(board.entries.map((entry) => [entry.name, entry.points, entry.survivalSec])).toEqual([
        ["Друг", 2_400, 400],
        ["Я", 1_800, 900],
      ]);
      expect(board.me).toMatchObject({ rank: 2, points: 1_800, survivalSec: 900 });
    });
  });

  describe("награда сезона: порог участника в очках", () => {
    it("799 очков — награды участника нет, 800 — есть; время забега порога не решает", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt, week.startsAt);
      const short = await player("Не дотянул");
      const enough = await player("Дотянул");
      // 799 очков при 400 с (по порогу времени награда была бы) и 800 очков при 50 с (по порогу времени её не было бы).
      await save(short.accountId, new Date(week.startsAt.getTime() + HOUR), 400, 799);
      await save(enough.accountId, new Date(week.startsAt.getTime() + 2 * HOUR), 50, 800);

      const closed = await w.close.closeDue(new Date(week.endsAt.getTime() + HOUR));

      expect(closed?.map((item) => item.seasonKey)).toEqual([week.key]);
      expect(await seasonsRepository.rewardOf(week.key, short.accountId)).toBeNull();
      expect(await seasonsRepository.rewardOf(week.key, enough.accountId)).toMatchObject({ kind: "threshold", coins: THRESHOLD_REWARD.coins, prestige: THRESHOLD_REWARD.prestige });
      const history = await seasonsRepository.history(enough.accountId, 8);
      expect(history[0]?.results).toEqual([{ difficulty: "hard", bestSec: 800, place: 1, boardSize: 2 }]);
    });

    it("порог из панели: rating.season-threshold-points ставит планку закрытию сезона", async () => {
      const week = await freeWeek();
      const settings = panelSettings({ [START_KEY]: settingOf(week.startsAt), [POINTS_FROM_KEY]: settingOf(week.startsAt), "rating.season-threshold-points": 1_000 });
      const schedule = new SeasonSchedule(settings);
      const rating = ratingRestrictions(runs, leaderboard, undefined, settings);
      const close = new SeasonsCloseService(redis, schedule, closeRepository, rating.gate);
      const me = await player();
      await save(me.accountId, new Date(week.startsAt.getTime() + HOUR), 400, 900);

      await close.closeDue(new Date(week.endsAt.getTime() + HOUR));

      expect(await seasonsRepository.rewardOf(week.key, me.accountId)).toBeNull();
    });

    it("сезон до понедельника перехода закрывается по времени: порог — секунды сложности", async () => {
      const before = await freeWeek();
      const w = world(before.startsAt, new Date(before.endsAt.getTime()));
      const quick = await player("Быстрый");
      const long = await player("Долгий");
      // 799 очков при 400 с — по времени награда есть; 800 очков при 50 с — по времени её нет.
      await save(quick.accountId, new Date(before.startsAt.getTime() + HOUR), 50, 800);
      await save(long.accountId, new Date(before.startsAt.getTime() + 2 * HOUR), 400, 799);

      await w.close.closeDue(new Date(before.endsAt.getTime() + HOUR));

      expect(await seasonsRepository.rewardOf(before.key, quick.accountId)).toBeNull();
      expect(await seasonsRepository.rewardOf(before.key, long.accountId)).toMatchObject({ kind: "threshold" });
      const history = await seasonsRepository.history(long.accountId, 8);
      expect(history[0]?.results).toEqual([{ difficulty: "hard", bestSec: 400, place: 1, boardSize: 2 }]);
    });
  });
});
