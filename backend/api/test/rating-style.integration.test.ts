import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import { PlayerStyleService, PrismaPlayerStyleRepository } from "../src/modules/rating/player-style.service.js";
import type { AxisId, AxisValues } from "../src/modules/rating/score-rules.js";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { RedisLeaderboardStore } from "../src/modules/runs/leaderboard.store.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { PrismaRunsRepository, type RunFinishRecord } from "../src/modules/runs/runs.repository.js";
import { RedisSeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { seasonOf, type Season } from "../src/modules/seasons/season-rules.js";
import { PrismaSeasonCloseRepository } from "../src/modules/seasons/seasons-close.repository.js";
import { SeasonsCloseService } from "../src/modules/seasons/seasons-close.service.js";
import { SeasonsProjection } from "../src/modules/seasons/seasons-projection.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonsViewService } from "../src/modules/seasons/seasons-view.service.js";
import { PrismaSeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import { ratingRestrictions } from "./helpers/memory-runs.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Дивизионы сезона и «Твой стиль» на настоящих Postgres и Redis (tasks/T-0295).
 * Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них файл пропускается.
 *
 * Память не покажет главного: что стиль выбирает база по `points` лучшего
 * забега окна, что «последние десять» отсчитываются по времени конца забега, а
 * закрытие сезона пишет дивизион в итог тем же запросом, что и место.
 *
 * Недели берутся из далёкого будущего (с 2047 года, чтобы не пересекаться с
 * файлом досок по очкам): база общая для всех прогонов.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 12);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FIRST_MONDAY = Date.UTC(2047, 0, 7);
const START_KEY = "seasons.start-date";
const POINTS_FROM_KEY = "rating.points-from";

function settingOf(monday: Date): number {
  return Number(monday.toISOString().slice(0, 10).replaceAll("-", ""));
}

/** Оси забега: единица, кроме названных. */
function axes(patch: Partial<AxisValues>): AxisValues {
  return { t: 1, k: 1, h: 1, c: 1, b: 1, ...patch };
}

/** Момент через столько-то часов после начала недели: порядок забегов в тестах задан однозначно. */
function hoursAfter(week: Season, hours: number): Date {
  return new Date(week.startsAt.getTime() + hours * HOUR);
}

describe.skipIf(!live)("дивизионы и стиль игрока на живых Postgres и Redis", () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let runs: PrismaRunsRepository;
  let friends: PrismaFriendsRepository;
  let leaderboard: RedisLeaderboardStore;
  let seasonStore: RedisSeasonBoardStore;
  let seasonsRepository: PrismaSeasonsRepository;
  let closeRepository: PrismaSeasonCloseRepository;
  let styles: PlayerStyleService;

  beforeAll(async () => {
    const config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    await prisma.$executeRaw`DELETE FROM season WHERE starts_at >= '2047-01-01'`;
    await prisma.$executeRaw`DELETE FROM run WHERE finished_at >= '2047-01-01'`;
    accounts = new PrismaAccountRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    friends = new PrismaFriendsRepository(prisma);
    leaderboard = new RedisLeaderboardStore(redis);
    seasonStore = new RedisSeasonBoardStore(redis);
    seasonsRepository = new PrismaSeasonsRepository(prisma);
    closeRepository = new PrismaSeasonCloseRepository(prisma);
    styles = new PlayerStyleService(new PrismaPlayerStyleRepository(prisma), panelSettings());
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  async function player(name = "Игрок"): Promise<string> {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(600_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: name, username: null, photoUrl: null }, Date.now());
    return created.accountId;
  }

  const handedOut = new Set<string>();

  /** Неделя далёкого будущего, на которой нет ни сезона, ни забегов, ни таблиц в Redis. */
  async function freeWeek(): Promise<Season> {
    for (;;) {
      const season = seasonOf(new Date(FIRST_MONDAY + (1_000 + Math.floor(Math.random() * 1_400)) * 7 * DAY));
      if (handedOut.has(season.key)) continue;
      const taken = (await prisma.season.count({ where: { startsAt: season.startsAt } })) + (await prisma.run.count({ where: { finishedAt: { gte: season.startsAt, lt: season.endsAt } } }));
      if (taken > 0) continue;
      if ((await redis.exists(...["easy", "normal", "hard"].map((difficulty) => `seasons:pts:${season.key}:${difficulty}`))) > 0) continue;
      handedOut.add(season.key);
      return season;
    }
  }

  /** Рейтинговый забег прямо в базе: очки, оси и стиль задаёт тест. */
  async function save(accountId: string, at: Date, points: number | null, runAxes: AxisValues, style: AxisId = "k", ranked = true): Promise<void> {
    const record: RunFinishRecord = {
      runId: randomUUID(),
      accountId,
      difficulty: "hard",
      startingWeaponId: "knife",
      contentHash: "abc",
      finishedAt: at,
      outcome: "died",
      survivalSec: 600,
      level: 6,
      enemiesKilled: 300,
      weapons: [{ id: "knife", level: 2 }],
      details: null,
      deathCause: null,
      cheats: false,
      continues: [],
      ranked,
      ratingRestricted: null,
      verdict: "ok",
      verdictReasons: [],
      rubezhReached: false,
      rubezhClearedSec: null,
      score: points === null ? null : { points, axes: runAxes, style, band: "average" },
    };
    expect(await runs.finish(record)).toBe("finished");
  }

  /** Мир теста: сезоны идут с `start`, все по очкам. */
  function world(start: Date) {
    const settings = panelSettings({ [START_KEY]: settingOf(start), [POINTS_FROM_KEY]: settingOf(start) });
    const schedule = new SeasonSchedule(settings);
    const rating = ratingRestrictions(runs, leaderboard, undefined, settings);
    const projection = new SeasonsProjection(schedule, seasonStore, seasonsRepository, new RunsHooks(), new RestrictionsHooks(), rating.gate, rating.rating);
    const view = new SeasonsViewService(schedule, seasonsRepository, seasonStore, friends, rating.gate, rating.rating);
    const close = new SeasonsCloseService(redis, schedule, closeRepository, rating.gate);
    return { schedule, projection, view, close };
  }

  describe("стиль игрока у имени", () => {
    it("стиль — у лучшего по очкам забега окна сезона, а не у последнего и не у самого долгого", async () => {
      const week = await freeWeek();
      const me = await player();
      await save(me, hoursAfter(week, 1), 900, axes({ k: 2 }), "k");
      await save(me, hoursAfter(week, 2), 1_400, axes({ c: 2 }), "c");
      await save(me, hoursAfter(week, 3), 1_100, axes({ h: 2 }), "h");

      const found = await styles.styleOfMany([me], { from: week.startsAt, to: week.endsAt });

      expect(found.get(me)).toBe("c");
    });

    it("в сезоне забегов нет — стиль лучшего забега за всё время", async () => {
      const week = await freeWeek();
      const other = await freeWeek();
      const me = await player();
      await save(me, hoursAfter(other, 1), 700, axes({ t: 2 }), "t");
      await save(me, hoursAfter(other, 2), 1_600, axes({ b: 2 }), "b");

      const found = await styles.styleOfMany([me], { from: week.startsAt, to: week.endsAt });

      expect(found.get(me)).toBe("b");
    });

    it("забеги без очков и снятые модератором стиля не дают: игрока нет в ответе", async () => {
      const week = await freeWeek();
      const me = await player();
      const stranger = await player();
      await save(me, hoursAfter(week, 1), null, axes({}));
      await save(me, hoursAfter(week, 2), 2_000, axes({ h: 2 }), "h", false);

      const found = await styles.styleOfMany([me, stranger], { from: week.startsAt, to: week.endsAt });

      expect(found.has(me)).toBe(false);
      expect(found.has(stranger)).toBe(false);
    });

    it("несколько игроков — одним обращением, у каждого свой стиль", async () => {
      const week = await freeWeek();
      const first = await player();
      const second = await player();
      await save(first, hoursAfter(week, 1), 1_000, axes({ t: 2 }), "t");
      await save(second, hoursAfter(week, 1), 1_000, axes({ c: 2 }), "c");

      const found = await styles.styleOfMany([first, second], { from: week.startsAt, to: week.endsAt });

      expect([found.get(first), found.get(second)]).toEqual(["t", "c"]);
    });
  });

  describe("«Твой стиль»", () => {
    it("считает по десяти последним: старые забеги в среднее не входят", async () => {
      const week = await freeWeek();
      const me = await player();
      // Два старых забега с большой Охотой и десять новых с Натиском: Охота не должна пережить усечение.
      await save(me, hoursAfter(week, 1), 1_000, axes({ h: 3 }), "h");
      await save(me, hoursAfter(week, 2), 1_000, axes({ h: 3 }), "h");
      for (let index = 0; index < 10; index += 1) await save(me, hoursAfter(week, 10 + index), 1_000, axes({ k: 2, c: 0.5 }), "k");

      const result = await styles.myStyle(me);

      expect(result).toMatchObject({ style: "k", strong: "k", weak: "c", runs: 10, missing: 0 });
      expect(result.axes).toEqual({ t: 1, k: 2, h: 1, c: 0.5, b: 1 });
    });

    it("сильная и слабая ось верны на шести забегах", async () => {
      const week = await freeWeek();
      const me = await player();
      for (let index = 0; index < 6; index += 1) await save(me, hoursAfter(week, 1 + index), 1_000, axes({ t: 0.6, h: 1.9, b: 1.2 }), "h");

      expect(await styles.myStyle(me)).toMatchObject({ style: "h", strong: "h", weak: "t", runs: 6 });
    });

    it("два забега — стиля нет, сказано, что нужен ещё один", async () => {
      const week = await freeWeek();
      const me = await player();
      await save(me, hoursAfter(week, 1), 1_000, axes({ k: 2 }), "k");
      await save(me, hoursAfter(week, 2), 1_000, axes({ k: 2 }), "k");

      expect(await styles.myStyle(me)).toEqual({ style: null, strong: null, weak: null, axes: null, runs: 2, missing: 1 });
    });

    it("забеги без очков, снятые модератором и чужие в счёт не идут", async () => {
      const week = await freeWeek();
      const me = await player();
      const other = await player();
      await save(me, hoursAfter(week, 1), null, axes({}));
      await save(me, hoursAfter(week, 2), 1_500, axes({ k: 2 }), "k", false);
      await save(other, hoursAfter(week, 3), 1_500, axes({ k: 2 }), "k");

      expect(await styles.myStyle(me)).toMatchObject({ runs: 0, missing: 3 });
    });
  });

  describe("дивизион сезона", () => {
    /** Игроки с убывающими очками: чем раньше в списке, тем выше место. */
    async function fillBoard(week: Season, count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const id = await player(`Игрок ${index + 1}`);
        ids.push(id);
        await save(id, hoursAfter(week, 1), 3_000 - index * 10, axes({}));
      }
      return ids;
    }

    it("закрытие сезона пишет дивизион в итог: доска из 20 — рубин, золото, серебро и бронза по долям", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt);
      const ids = await fillBoard(week, 20);

      await w.close.closeDue(new Date(week.endsAt.getTime() + HOUR));

      const rows = await prisma.$queryRaw<{ account_id: string; place: number; division: string | null }[]>`
        SELECT account_id, place, division FROM season_result WHERE season_key = ${week.key} ORDER BY place`;
      expect(rows).toHaveLength(20);
      expect(rows.map((row) => row.division)).toEqual([
        "ruby", // 1-е: ceil(0,01 × 20) = 1
        "gold", // 2-е: ceil(0,10 × 20) = 2
        ...Array<string>(5).fill("silver"), // 3–7: ceil(0,35 × 20) = 7
        ...Array<string>(13).fill("bronze"),
      ]);
      expect(rows[0]?.account_id).toBe(ids[0]);
    });

    it("доска из трёх: рубин, серебро, бронза", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt);
      await fillBoard(week, 3);

      await w.close.closeDue(new Date(week.endsAt.getTime() + HOUR));

      const rows = await prisma.$queryRaw<{ division: string | null }[]>`SELECT division FROM season_result WHERE season_key = ${week.key} ORDER BY place`;
      expect(rows.map((row) => row.division)).toEqual(["ruby", "silver", "bronze"]);
    });

    it("история игрока несёт дивизион строки итога; в сезоне, закрытом до задачи, он null", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt);
      const ids = await fillBoard(week, 20);
      await w.close.closeDue(new Date(week.endsAt.getTime() + HOUR));

      const history = await seasonsRepository.history(ids[0] ?? "", 8);
      expect(history[0]?.results).toEqual([{ difficulty: "hard", bestSec: 3_000, place: 1, boardSize: 20, division: "ruby" }]);

      await prisma.$executeRaw`UPDATE season_result SET division = NULL WHERE season_key = ${week.key}`;
      expect((await seasonsRepository.history(ids[0] ?? "", 8))[0]?.results[0]?.division).toBeNull();
    });

    it("доска сезона: дивизион у строк и у «меня» — по месту и размеру доски; без забега «меня» нет", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt);
      const ids = await fillBoard(week, 20);
      await w.projection.rebuild(hoursAfter(week, 2));
      const at = hoursAfter(week, 3);

      const top = await w.view.board(ids[0] ?? "", { difficulty: "hard", scope: "all" }, at);
      expect(top.me).toMatchObject({ rank: 1, division: "ruby" });
      expect(top.entries.map((entry) => entry.division)).toEqual(["ruby", "gold", ...Array<string>(5).fill("silver"), ...Array<string>(13).fill("bronze")]);

      const last = await w.view.board(ids[19] ?? "", { difficulty: "hard", scope: "all" }, at);
      expect(last.me).toMatchObject({ rank: 20, division: "bronze" });

      const idle = await player("Без забега");
      expect((await w.view.board(idle, { difficulty: "hard", scope: "all" }, at)).me).toBeNull();
    });

    it("доска друзей: у «меня» дивизион по общей доске сезона, а не по месту среди друзей", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt);
      const ids = await fillBoard(week, 20);
      await w.projection.rebuild(hoursAfter(week, 2));
      // 12-й дружит с 11-м: среди двоих он второй, а на общей доске из 20 его место — бронзовое (серебро кончается на 7-м).
      const me = ids[11] ?? "";
      await friends.befriend(me, ids[10] ?? "", "link", 10);

      const result = await w.view.board(me, { difficulty: "hard", scope: "friends" }, hoursAfter(week, 3));

      expect(result.me).toMatchObject({ rank: 2, division: "bronze" });
      // Строки друзей дивизиона не несут: их место среди друзей — не место на доске сезона.
      expect(result.entries.every((entry) => entry.division === null)).toBe(true);
    });

    it("обзор: дивизион игрока по сложностям", async () => {
      const week = await freeWeek();
      const w = world(week.startsAt);
      const ids = await fillBoard(week, 20);
      await w.projection.rebuild(hoursAfter(week, 2));

      const overview = await w.view.overview(ids[0] ?? "", hoursAfter(week, 3));

      expect(overview.division).toEqual({ easy: null, normal: null, hard: "ruby" });
    });
  });
});
