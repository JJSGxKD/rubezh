import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { PrismaFriendsRepository } from "../src/modules/friends/friends.repository.js";
import type { RestrictionRow } from "../src/modules/restrictions/restrictions.repository.js";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import { DIFFICULTIES } from "../src/modules/runs/run-rules.js";
import { PrismaRunsRepository, type RunFinishRecord } from "../src/modules/runs/runs.repository.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { boardViewSchema, claimResultSchema, overviewSchema } from "../src/modules/seasons/dto/seasons.dto.js";
import { RedisSeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { placeReward, seasonOf, standings, type Season, type StandingEntry } from "../src/modules/seasons/season-rules.js";
import { ALL_BOARDS, FULL_ONLY, type Board } from "../src/modules/runs/leaderboard.store.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonsClaimService } from "../src/modules/seasons/seasons-claim.service.js";
import { SeasonsCloseService } from "../src/modules/seasons/seasons-close.service.js";
import { PrismaSeasonCloseRepository } from "../src/modules/seasons/seasons-close.repository.js";
import { SeasonsProjection } from "../src/modules/seasons/seasons-projection.js";
import { PrismaSeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import { SeasonsViewService } from "../src/modules/seasons/seasons-view.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Недельный сезон на настоящих Postgres и Redis (docs/17-testing-strategy.md
 * §4.2; tasks/T-0110). Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL,
 * без них пропуск.
 *
 * Память этого не покажет: закрытие считает места оконной функцией в базе,
 * два закрытия разом упираются в уникальный `season_key`, а награда
 * начисляется один раз по ключу кошелька при любых гонках `claim`.
 *
 * Каждый тест берёт свою неделю далёкого будущего: база общая для всех
 * прогонов, и закрытый сезон прошлого прогона не должен мешать этому. Старт
 * сезонов настройки ставится на ту же неделю, чтобы «просроченными» были
 * только сезоны самого теста. Redis — своя база (сдвиг 8).
 *
 * Неделя принадлежит одному тесту целиком. Занятость проверяется не только по
 * базе: часть тестов пишет в таблицу недели, не трогая базу, и без памяти о
 * выданных неделях два теста изредка получали одну и ту же — тогда «всего в
 * таблице» оказывалось больше, чем положил сам тест.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 8);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FIRST_MONDAY = Date.UTC(2026, 10, 2);
const SETTING_KEY = "seasons.start-date";

/** Ограничение рейтинга в тесте: кого закрыли и молча ли. */
class FakeRestrictions {
  readonly restricted = new Map<string, { notify: boolean }>();
  async restrictedAccounts(): Promise<string[]> {
    return [...this.restricted.keys()];
  }
  async status(accountId: string): Promise<RestrictionRow | null> {
    const hit = this.restricted.get(accountId);
    return hit === undefined ? null : ({ kind: "leaderboard", notify: hit.notify } as unknown as RestrictionRow);
  }
}

/** Доска зрителя в тесте: у кого отдельная доска (T-0113) — решает множество, как решает ограничение в проде. */
class FakeRating {
  readonly separated = new Set<string>();
  async boardOf(accountId: string): Promise<Board> {
    return this.separated.has(accountId) ? "full" : "common";
  }
  async boardsFor(accountId: string): Promise<readonly Board[]> {
    return this.separated.has(accountId) ? FULL_ONLY : ALL_BOARDS;
  }
  async separate(): Promise<string[]> {
    return [...this.separated];
  }
}

/** Понедельник как число настройки: 20261102. */
function settingOf(monday: Date): number {
  return Number(monday.toISOString().slice(0, 10).replaceAll("-", ""));
}

describe.skipIf(!live)("недельный сезон на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let runs: PrismaRunsRepository;
  let wallet: WalletService;
  let friends: PrismaFriendsRepository;
  let store: RedisSeasonBoardStore;
  let repository: PrismaSeasonsRepository;
  let closeRepository: PrismaSeasonCloseRepository;
  let restrictions: FakeRestrictions;
  let rating: FakeRating;

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    // База своя у этого файла — очищать её можно.
    await redis.flushdb();
    // Недели далёкого будущего принадлежат только этому файлу: остатки прошлых прогонов не копятся.
    await prisma.$executeRaw`DELETE FROM season WHERE starts_at >= '2040-01-01'`;
    await prisma.$executeRaw`DELETE FROM run WHERE finished_at >= '2040-01-01'`;
    accounts = new PrismaAccountRepository(prisma);
    runs = new PrismaRunsRepository(prisma);
    wallet = new WalletService(new PrismaWalletRepository(prisma), config, new RolesService(config, new MemoryRolesRepository(), new MemoryAccountRepository()));
    friends = new PrismaFriendsRepository(prisma);
    store = new RedisSeasonBoardStore(redis);
    repository = new PrismaSeasonsRepository(prisma);
    closeRepository = new PrismaSeasonCloseRepository(prisma);
    restrictions = new FakeRestrictions();
    rating = new FakeRating();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restrictions.restricted.clear();
    rating.separated.clear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  async function account(name = "Игрок"): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(600_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: name, username: null, photoUrl: null },
      Date.now(),
    );
    return created.accountId;
  }

  /** Недели, уже выданные тестам этого прогона: тест, не записавший ничего в базу, всё равно держит свою неделю. */
  const handedOut = new Set<string>();

  /** Неделя далёкого будущего, на которой (и на `weeks - 1` следующих) нет ни сезона, ни забегов, ни таблицы в Redis, ни другого теста. */
  async function freeWeek(weeks = 1): Promise<Season> {
    for (;;) {
      const season = seasonOf(new Date(FIRST_MONDAY + (1_000 + Math.floor(Math.random() * 1_400)) * 7 * DAY));
      const until = new Date(season.startsAt.getTime() + weeks * 7 * DAY);
      const keys = Array.from({ length: weeks }, (_, index) => seasonOf(new Date(season.startsAt.getTime() + index * 7 * DAY)).key);
      if (keys.some((key) => handedOut.has(key))) continue;
      const taken = (await prisma.season.count({ where: { startsAt: { gte: season.startsAt, lt: until } } })) + (await prisma.run.count({ where: { finishedAt: { gte: season.startsAt, lt: until } } }));
      if (taken > 0) continue;
      const boards = keys.flatMap((key) => DIFFICULTIES.map((difficulty) => `seasons:${key}:${difficulty}`));
      if ((await redis.exists(...boards)) > 0) continue;
      for (const key of keys) handedOut.add(key);
      return season;
    }
  }

  function world(start: Date | null) {
    const settings = panelSettings(start === null ? {} : { [SETTING_KEY]: settingOf(start) });
    const schedule = new SeasonSchedule(settings);
    const runsHooks = new RunsHooks();
    const restrictionsHooks = new RestrictionsHooks();
    const projection = new SeasonsProjection(schedule, store, repository, runsHooks, restrictionsHooks, restrictions as never, rating as never);
    projection.onModuleInit();
    const close = new SeasonsCloseService(redis, schedule, closeRepository, restrictions as never);
    const claim = new SeasonsClaimService(repository, wallet);
    const view = new SeasonsViewService(schedule, repository, store, friends, restrictions as never, rating as never);
    return { settings, schedule, runsHooks, restrictionsHooks, projection, close, claim, view };
  }

  function finished(accountId: string, season: Season, patch: Partial<RunFinishRecord> & { offsetMs?: number } = {}): RunFinishRecord {
    const { offsetMs = HOUR, ...rest } = patch;
    return {
      runId: randomUUID(),
      accountId,
      difficulty: "easy",
      startingWeaponId: "knife",
      contentHash: "abc",
      finishedAt: new Date(season.startsAt.getTime() + offsetMs),
      outcome: "died",
      survivalSec: 200,
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
      ...rest,
    };
  }

  async function play(accountId: string, season: Season, patch: Partial<RunFinishRecord> & { offsetMs?: number } = {}): Promise<RunFinishRecord> {
    const record = finished(accountId, season, patch);
    expect(await runs.finish(record)).toBe("finished");
    return record;
  }

  function recorded(record: RunFinishRecord): RecordedRun {
    return {
      runId: record.runId,
      accountId: record.accountId,
      difficulty: record.difficulty,
      outcome: record.outcome,
      survivalSec: record.survivalSec,
      level: record.level,
      enemiesKilled: record.enemiesKilled,
      startingWeaponId: record.startingWeaponId,
      weapons: record.weapons,
      boosts: [],
      xpCollected: null,
      counters: null,
      deathCause: record.deathCause,
      cheats: record.cheats,
      continues: 0,
      ranked: record.ranked,
      verdict: record.verdict,
      reasons: record.verdictReasons,
      finishedAt: record.finishedAt,
    };
  }

  /** Сезон, где `count` игроков сыграли на лёгкой с убывающим временем; первый — самый долгий. */
  async function crowdedSeason(count = 12): Promise<{ season: Season; players: string[] }> {
    const season = await freeWeek();
    const players: string[] = [];
    for (let index = 0; index < count; index++) {
      const id = await account(`Игрок ${String(index + 1)}`);
      players.push(id);
      await play(id, season, { survivalSec: 500 - index * 10 });
    }
    return { season, players };
  }

  function after(season: Season, ms = HOUR): Date {
    return new Date(season.endsAt.getTime() + ms);
  }

  describe("живая таблица недели", () => {
    it("слушатель: неранговый забег и забег до старта сезонов не пишутся; худшее время не опускает лучшее; повтор того же забега ничего не меняет", async () => {
      const season = await freeWeek();
      const { projection } = world(season.startsAt);
      const id = await account();

      await projection.recorded(recorded(finished(id, season, { ranked: false, survivalSec: 900 })));
      expect(await store.best(season.key, "easy", id)).toBeNull();

      const before = finished(id, season, { survivalSec: 900, offsetMs: -HOUR });
      await projection.recorded(recorded(before));
      expect(await store.best(season.key, "easy", id)).toBeNull();
      expect(await store.best(seasonOf(before.finishedAt).key, "easy", id)).toBeNull();

      const good = finished(id, season, { survivalSec: 300 });
      await projection.recorded(recorded(good));
      await projection.recorded(recorded(finished(id, season, { survivalSec: 120 })));
      await projection.recorded(recorded(good));
      expect(await store.best(season.key, "easy", id)).toBe(300);
      expect(await store.count(season.key, "easy")).toBe(1);
    });

    it("пока настройка пуста, слушатель выключен", async () => {
      const season = await freeWeek();
      const { projection } = world(null);
      const id = await account();

      await projection.recorded(recorded(finished(id, season, { survivalSec: 300 })));

      expect(await store.best(season.key, "easy", id)).toBeNull();
    });

    it("ключ доски живёт 21 день после конца сезона", async () => {
      const season = await freeWeek();
      const { projection } = world(season.startsAt);
      const id = await account();
      await projection.recorded(recorded(finished(id, season, { survivalSec: 300 })));

      const ttl = await redis.pttl(`seasons:${season.key}:easy`);
      const expected = season.endsAt.getTime() + 21 * DAY - Date.now();

      // Часы Redis и теста могут расходиться на секунды: проверяется порядок величины, не миллисекунды.
      expect(Math.abs(ttl - expected)).toBeLessThan(60_000);
    });

    it("настоящий приём забега: повтор итога из очереди клиента второй записи не даёт", async () => {
      const season = await freeWeek();
      const { runsHooks } = world(season.startsAt);
      const id = await account();
      const submit = vi.spyOn(store, "submit");
      const record = finished(id, season, { survivalSec: 250 });
      // Приём забегов зовёт слушателей только при первой записи.
      expect(await runs.finish(record)).toBe("finished");
      await runsHooks.emit(recorded(record));
      expect(await runs.finish(record)).toBe("duplicate");

      expect(submit).toHaveBeenCalledTimes(1);
      expect(await store.best(season.key, "easy", id)).toBe(250);
    });

    it("снятие забега модератором: проекция недели пересчитывается из базы", async () => {
      const season = await freeWeek();
      const { projection } = world(season.startsAt);
      const id = await account();
      const best = await play(id, season, { survivalSec: 500 });
      await play(id, season, { survivalSec: 300, offsetMs: 2 * HOUR });
      await projection.recorded(recorded(best));
      expect(await store.best(season.key, "easy", id)).toBe(500);

      await runs.setRanked(best.runId, false);
      await projection.refresh(id, "easy", new Date(season.startsAt.getTime() + 3 * HOUR));
      expect(await store.best(season.key, "easy", id)).toBe(300);

      await runs.setRanked(best.runId, true);
      await projection.refresh(id, "easy", new Date(season.startsAt.getTime() + 3 * HOUR));
      expect(await store.best(season.key, "easy", id)).toBe(500);
    });

    it("пересборка из базы: окно текущей недели, мусор из проекции уходит", async () => {
      const season = await freeWeek();
      const { projection } = world(season.startsAt);
      const [fast, slow, outside] = [await account(), await account(), await account()];
      await play(fast, season, { survivalSec: 400 });
      await play(slow, season, { survivalSec: 100 });
      await play(outside, season, { survivalSec: 999, offsetMs: -DAY });
      await redis.zadd(`seasons:${season.key}:easy`, 99_999, "призрак");

      await projection.rebuild(new Date(season.startsAt.getTime() + 2 * HOUR));

      expect(await store.best(season.key, "easy", "призрак")).toBeNull();
      expect(await store.best(season.key, "easy", outside)).toBeNull();
      expect((await store.rank(season.key, "easy", fast)) ?? 9).toBeLessThan((await store.rank(season.key, "easy", slow)) ?? 0);
    });

    it("ограничение рейтинга: игрок уходит из недельной доски сразу и возвращается, когда ограничение снято", async () => {
      const season = await freeWeek();
      const { projection, restrictionsHooks } = world(season.startsAt);
      const id = await account();
      const record = await play(id, season, { survivalSec: 300 });
      await projection.recorded(recorded(record));
      const at = new Date(season.startsAt.getTime() + 2 * HOUR);

      restrictions.restricted.set(id, { notify: true });
      await restrictionsHooks.emitImposed({ accountId: id, kinds: ["leaderboard"], at });
      expect(await store.best(season.key, "easy", id)).toBeNull();

      restrictions.restricted.delete(id);
      await restrictionsHooks.emitSettled({ accountId: id, kinds: ["leaderboard"], at });
      expect(await store.best(season.key, "easy", id)).toBe(300);
    });
  });

  describe("закрытие сезона", () => {
    it("три аккаунта в окне: места по времени, ничья решена ранним временем, награда за порог, строка сезона", async () => {
      const season = await freeWeek();
      const { close } = world(season.startsAt);
      const [late, early, third] = [await account("Позже"), await account("Раньше"), await account("Третий")];
      await play(late, season, { survivalSec: 300, offsetMs: 5 * HOUR });
      await play(early, season, { survivalSec: 300, offsetMs: 1 * HOUR });
      await play(third, season, { survivalSec: 200, offsetMs: 2 * HOUR });
      // Хуже и позже лучшего — на места не влияют.
      await play(early, season, { survivalSec: 100, offsetMs: 3 * HOUR });

      const closed = await close.closeDue(after(season));

      expect(closed?.map((item) => item.seasonKey)).toEqual([season.key]);
      const rows = await prisma.seasonResult.findMany({ where: { seasonKey: season.key }, orderBy: { place: "asc" } });
      expect(rows.map((row) => [row.accountId, row.difficulty, row.bestSec, row.place, row.boardSize])).toEqual([
        [early, "easy", 300, 1, 3],
        [late, "easy", 300, 2, 3],
        [third, "easy", 200, 3, 3],
      ]);
      expect(await prisma.season.findUnique({ where: { seasonKey: season.key } })).toMatchObject({ players: 3, rewarded: 3 });
      // В таблице меньше десяти игроков — места не награждаются, все трое дотянули до порога лёгкой (180 с).
      const rewards = await prisma.seasonReward.findMany({ where: { seasonKey: season.key } });
      expect(rewards.map((row) => [row.kind, row.coins, row.prestige, row.status, row.difficulty, row.place])).toEqual([
        ["threshold", 150, 5, "pending", null, null],
        ["threshold", 150, 5, "pending", null, null],
        ["threshold", 150, 5, "pending", null, null],
      ]);
    });

    it("таблица от десяти игроков: награда за место заменяет награду за порог", async () => {
      const { season, players } = await crowdedSeason();
      const { close } = world(season.startsAt);

      await close.closeDue(after(season));

      const rewards = new Map((await prisma.seasonReward.findMany({ where: { seasonKey: season.key } })).map((row) => [row.accountId, row]));
      expect(rewards.size).toBe(12);
      expect(rewards.get(players[0] ?? "")).toMatchObject({ kind: "place", coins: 1000, prestige: 100, place: 1, difficulty: "easy" });
      expect(rewards.get(players[2] ?? "")).toMatchObject({ coins: 600, prestige: 50, place: 3 });
      expect(rewards.get(players[9] ?? "")).toMatchObject({ coins: 400, prestige: 25, place: 10 });
      expect(rewards.get(players[10] ?? "")).toMatchObject({ coins: 250, prestige: 10, place: 11 });
      expect(await prisma.season.findUnique({ where: { seasonKey: season.key } })).toMatchObject({ players: 12, rewarded: 12 });
    });

    it("повторное закрытие: ни новых строк, ни второго season_closed", async () => {
      const { season } = await crowdedSeason(3);
      const { close } = world(season.startsAt);
      const log = vi.spyOn(Logger.prototype, "log");
      const announcements = () => log.mock.calls.filter(([line]) => typeof line === "string" && line.includes('"season_closed"') && line.includes(season.key)).length;

      await close.closeDue(after(season));
      const counts = async () => [await prisma.season.count({ where: { seasonKey: season.key } }), await prisma.seasonResult.count({ where: { seasonKey: season.key } }), await prisma.seasonReward.count({ where: { seasonKey: season.key } })];
      const first = await counts();
      expect(announcements()).toBe(1);

      expect(await close.closeDue(after(season, 2 * HOUR))).toEqual([]);
      expect(await counts()).toEqual(first);
      expect(announcements()).toBe(1);
    });

    it("два закрытия параллельно без общего лока (две реплики): одна строка сезона, награды без дублей, закрыла одна", async () => {
      const { season } = await crowdedSeason(12);
      const now = after(season);

      const outcomes = await Promise.all([closeRepository.close(season, [], now), closeRepository.close(season, [], now)]);

      expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1);
      expect(await prisma.season.count({ where: { seasonKey: season.key } })).toBe(1);
      expect(await prisma.seasonReward.count({ where: { seasonKey: season.key } })).toBe(12);
      expect(await prisma.seasonResult.count({ where: { seasonKey: season.key } })).toBe(12);
    });

    it("два закрытия сервисом разом: лок одной реплики пропускает одного", async () => {
      const { season } = await crowdedSeason(3);
      const { close } = world(season.startsAt);

      const outcomes = await Promise.all([close.closeDue(after(season)), close.closeDue(after(season))]);

      expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
      expect(await prisma.season.count({ where: { seasonKey: season.key } })).toBe(1);
    });

    it("аккаунт с ограничением рейтинга на момент закрытия не получает награды и не занимает места", async () => {
      const { season, players } = await crowdedSeason(12);
      const { close } = world(season.startsAt);
      restrictions.restricted.set(players[0] ?? "", { notify: true });

      await close.closeDue(after(season));

      expect(await prisma.seasonReward.findUnique({ where: { seasonKey_accountId: { seasonKey: season.key, accountId: players[0] ?? "" } } })).toBeNull();
      expect(await prisma.seasonResult.count({ where: { seasonKey: season.key, accountId: players[0] ?? "" } })).toBe(0);
      expect(await prisma.seasonResult.findFirst({ where: { seasonKey: season.key, accountId: players[1] ?? "" } })).toMatchObject({ place: 1, boardSize: 11 });
    });

    it("сезон ещё идёт — не закрывается; в последнюю миллисекунду тоже", async () => {
      const { season } = await crowdedSeason(3);
      const { close } = world(season.startsAt);

      expect(await close.closeDue(new Date(season.startsAt.getTime() + 3 * DAY))).toEqual([]);
      expect(await close.closeDue(new Date(season.endsAt.getTime() - 1))).toEqual([]);
      expect(await prisma.season.count({ where: { seasonKey: season.key } })).toBe(0);
    });

    it("сервер «лежал» две недели: закрыты обе по порядку, у каждой свои результаты", async () => {
      const first = await freeWeek(2);
      const second = seasonOf(first.endsAt);
      const { close } = world(first.startsAt);
      const [a, b] = [await account(), await account()];
      await play(a, first, { survivalSec: 300 });
      await play(b, second, { survivalSec: 250 });

      const closed = await close.closeDue(new Date(second.endsAt.getTime() + 3 * HOUR));

      expect(closed?.map((item) => item.seasonKey)).toEqual([first.key, second.key]);
      expect((await prisma.seasonResult.findMany({ where: { seasonKey: first.key } })).map((row) => row.accountId)).toEqual([a]);
      expect((await prisma.seasonResult.findMany({ where: { seasonKey: second.key } })).map((row) => row.accountId)).toEqual([b]);
      const rows = await prisma.season.findMany({ where: { seasonKey: { in: [first.key, second.key] } }, orderBy: { startsAt: "asc" } });
      expect(rows.map((row) => row.seasonKey)).toEqual([first.key, second.key]);
    });

    it("снятие забега модератором до закрытия: время на закрытии откатилось", async () => {
      const season = await freeWeek();
      const { close } = world(season.startsAt);
      const id = await account();
      const best = await play(id, season, { survivalSec: 500 });
      await play(id, season, { survivalSec: 300, offsetMs: 2 * HOUR });
      await runs.setRanked(best.runId, false);

      await close.closeDue(after(season));

      expect(await prisma.seasonResult.findFirst({ where: { seasonKey: season.key, accountId: id } })).toMatchObject({ bestSec: 300 });
    });

    it("границы окна: забег ровно в начале недели — в сезоне, ровно в конце — уже в следующем; нерейтинговые и незаконченные не в счёт", async () => {
      const season = await freeWeek();
      const { close } = world(season.startsAt);
      const [atStart, atEnd, unranked, started] = [await account(), await account(), await account(), await account()];
      await play(atStart, season, { offsetMs: 0 });
      await play(atEnd, season, { offsetMs: DAY * 7 });
      await play(unranked, season, { ranked: false });
      await runs.start({ runId: randomUUID(), accountId: started, difficulty: "easy", startingWeaponId: "knife", contentHash: "abc", startedAt: new Date(season.startsAt.getTime() + HOUR) });

      await close.closeDue(after(season));

      const ids = (await prisma.seasonResult.findMany({ where: { seasonKey: season.key } })).map((row) => row.accountId);
      expect(ids).toEqual([atStart]);
    });

    it("сезон без игроков закрывается пустой строкой, а не остаётся «вечно просроченным»", async () => {
      const season = await freeWeek();
      const { close } = world(season.startsAt);

      const closed = await close.closeDue(after(season));

      expect(closed).toEqual([expect.objectContaining({ seasonKey: season.key, players: 0, rewarded: 0 })]);
      expect(await close.closeDue(after(season, DAY))).toEqual([]);
    });
  });

  describe("доски зрителя (T-0114, Р104)", () => {
    /** Скрытое ограничение «Отдельная доска» строкой базы: закрытие читает его из неё. */
    async function impose(accountId: string, season: Season, patch: { liftedAt?: Date; endsAt?: Date | null } = {}): Promise<void> {
      await prisma.accountRestriction.create({
        data: {
          accountId,
          kind: "separate_board",
          startsAt: new Date(season.startsAt.getTime() - 30 * DAY),
          endsAt: patch.endsAt ?? null,
          reason: "other",
          notify: false,
          ...(patch.liftedAt === undefined ? {} : { liftedAt: patch.liftedAt, liftComment: "снято" }),
        },
      });
    }

    /** Обычные и с отдельной доской: двое первых ограниченных быстрее всех обычных, третий — медленнее всех. */
    async function mixedSeason(ordinary = 9, separate = 3) {
      const season = await freeWeek();
      const normal: string[] = [];
      const restricted: string[] = [];
      for (let index = 0; index < ordinary; index++) {
        const id = await account(`Обычный ${String(index + 1)}`);
        normal.push(id);
        await play(id, season, { survivalSec: 400 - index * 10, offsetMs: (index + 1) * HOUR });
      }
      for (let index = 0; index < separate; index++) {
        const id = await account(`Отдельный ${String(index + 1)}`);
        restricted.push(id);
        await impose(id, season);
        await play(id, season, { survivalSec: [1_000, 900, 50][index] ?? 50, offsetMs: (index + 1) * HOUR });
      }
      return { season, normal, restricted };
    }

    it("закрытие: девять обычных и три с отдельной доской — у обычных таблица из девяти без награды за место, у троих полная из двенадцати с ней", async () => {
      const { season, normal, restricted } = await mixedSeason();
      const { close } = world(season.startsAt);

      await close.closeDue(after(season));

      const results = new Map((await prisma.seasonResult.findMany({ where: { seasonKey: season.key } })).map((row) => [row.accountId, row]));
      for (const id of normal) expect(results.get(id), id).toMatchObject({ board: "common", boardSize: 9 });
      for (const id of restricted) expect(results.get(id), id).toMatchObject({ board: "full", boardSize: 12 });
      expect(normal.map((id) => results.get(id)?.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(restricted.map((id) => results.get(id)?.place)).toEqual([1, 2, 12]);

      const rewards = new Map((await prisma.seasonReward.findMany({ where: { seasonKey: season.key } })).map((row) => [row.accountId, row]));
      // Девять — меньше MIN_BOARD: места не награждаются, остаётся награда за порог.
      for (const id of normal) expect(rewards.get(id), id).toMatchObject({ kind: "threshold", coins: 150, prestige: 5, place: null });
      expect(rewards.get(restricted[0] ?? "")).toMatchObject({ kind: "place", coins: 1000, prestige: 100, place: 1, difficulty: "easy" });
      expect(rewards.get(restricted[1] ?? "")).toMatchObject({ kind: "place", coins: 600, prestige: 50, place: 2 });
      expect(rewards.get(restricted[2] ?? "")).toMatchObject({ kind: "place", coins: 250, prestige: 10, place: 12 });
    });

    it("места в базе сходятся с моделью standings: та же ничья, те же плотные места общей таблицы", async () => {
      const { season, normal, restricted } = await mixedSeason(10, 2);
      // Ничья по времени с обычным: решает тот, кто показал раньше.
      const tie = await account("Ничья");
      await play(tie, season, { survivalSec: 400, offsetMs: 30 * HOUR });
      const { close } = world(season.startsAt);

      await close.closeDue(after(season));

      const bests = await prisma.run.groupBy({ by: ["accountId"], where: { finishedAt: { gte: season.startsAt, lt: season.endsAt }, difficulty: "easy" }, _max: { survivalSec: true, finishedAt: true } });
      const entries: StandingEntry[] = bests.map((row) => ({ accountId: row.accountId, bestSec: row._max.survivalSec ?? 0, firstAt: row._max.finishedAt ?? new Date(0) }));
      const model = standings(entries, new Set(restricted));
      const rows = await prisma.seasonResult.findMany({ where: { seasonKey: season.key } });
      const byAccount = new Map(rows.map((row) => [row.accountId, [row.place, row.boardSize, row.board]]));
      for (const row of model.common) expect(byAccount.get(row.accountId), row.accountId).toEqual([row.place, row.boardSize, "common"]);
      for (const row of model.full.filter((candidate) => restricted.includes(candidate.accountId))) expect(byAccount.get(row.accountId), row.accountId).toEqual([row.place, row.boardSize, "full"]);
      expect(rows).toHaveLength(normal.length + restricted.length + 1);
    });

    it("обычный игрок, которого аккаунт с ограничением обогнал бы, получает место «как будто его нет»", async () => {
      const season = await freeWeek();
      const crowd: string[] = [];
      for (let index = 0; index < 10; index++) {
        const id = await account();
        crowd.push(id);
        await play(id, season, { survivalSec: 300 - index * 10 });
      }
      const fast = await account("Отдельный быстрый");
      await impose(fast, season);
      await play(fast, season, { survivalSec: 900 });
      const { close } = world(season.startsAt);

      await close.closeDue(after(season));

      expect(await prisma.seasonResult.findFirst({ where: { seasonKey: season.key, accountId: crowd[0] } })).toMatchObject({ place: 1, boardSize: 10, board: "common" });
      expect(await prisma.seasonReward.findFirst({ where: { seasonKey: season.key, accountId: crowd[0] } })).toMatchObject({ kind: "place", coins: 1000, place: 1 });
      expect(await prisma.seasonResult.findFirst({ where: { seasonKey: season.key, accountId: fast } })).toMatchObject({ place: 1, boardSize: 11, board: "full" });
    });

    it("снятие ограничения до закрытия возвращает аккаунт в общую таблицу; ещё действующее со сроком в будущем — нет", async () => {
      const season = await freeWeek();
      const [lifted, running, expired] = [await account("Снято"), await account("Действует"), await account("Истекло")];
      await impose(lifted, season, { liftedAt: new Date(season.startsAt.getTime() + 2 * DAY) });
      await impose(running, season, { endsAt: new Date(season.endsAt.getTime() + 10 * DAY) });
      await impose(expired, season, { endsAt: new Date(season.endsAt.getTime() - HOUR) });
      for (const id of [lifted, running, expired]) await play(id, season, { survivalSec: 250 });
      const { close } = world(season.startsAt);

      await close.closeDue(after(season));

      const boardOf = async (id: string) => (await prisma.seasonResult.findFirst({ where: { seasonKey: season.key, accountId: id } }))?.board;
      expect(await boardOf(lifted)).toBe("common");
      expect(await boardOf(expired)).toBe("common");
      expect(await boardOf(running)).toBe("full");
      expect(await prisma.seasonResult.findFirst({ where: { seasonKey: season.key, accountId: lifted } })).toMatchObject({ boardSize: 2 });
    });

    it("повторное закрытие ничего не вставляет; колонка board у старых строк — common по умолчанию", async () => {
      const { season } = await mixedSeason(4, 2);
      const { close } = world(season.startsAt);
      await close.closeDue(after(season));
      const counts = async () => [await prisma.seasonResult.count({ where: { seasonKey: season.key } }), await prisma.seasonReward.count({ where: { seasonKey: season.key } })];
      const first = await counts();

      expect(await closeRepository.close(season, [], after(season, 2 * HOUR))).toBeNull();
      expect(await close.closeDue(after(season, 3 * HOUR))).toEqual([]);
      expect(await counts()).toEqual(first);

      // Строка без явной доски (как до T-0114) читается обычной.
      const legacy = await account();
      await prisma.$executeRaw`INSERT INTO season_result (season_key, account_id, difficulty, best_sec, place, board_size) VALUES (${season.key}, ${legacy}::uuid, 'hard', 10, 1, 1)`;
      expect((await prisma.seasonResult.findFirst({ where: { seasonKey: season.key, accountId: legacy } }))?.board).toBe("common");
    });

    it("награда за порог у аккаунта с ограничением такая же, как у обычного с тем же временем", async () => {
      const season = await freeWeek();
      const [ordinary, separate] = [await account("Обычный"), await account("Отдельный")];
      await impose(separate, season);
      await play(ordinary, season, { survivalSec: 200 });
      await play(separate, season, { survivalSec: 200 });
      const { close } = world(season.startsAt);

      await close.closeDue(after(season));

      const rewards = await prisma.seasonReward.findMany({ where: { seasonKey: season.key, accountId: { in: [ordinary, separate] } } });
      expect(rewards.map((row) => [row.kind, row.coins, row.prestige, row.difficulty, row.place])).toEqual([
        ["threshold", 150, 5, null, null],
        ["threshold", 150, 5, null, null],
      ]);
    });

    it("рейтинг закрыт сильнее: под ограничением «leaderboard» или блокировкой, пусть и с отдельной доской, наград нет ни на какой доске", async () => {
      const season = await freeWeek();
      const [closed, blocked, ordinary] = [await account("Закрыт"), await account("Блок"), await account("Обычный")];
      for (const id of [closed, blocked]) await impose(id, season);
      for (const id of [closed, blocked, ordinary]) await play(id, season, { survivalSec: 300 });
      restrictions.restricted.set(closed, { notify: true });
      restrictions.restricted.set(blocked, { notify: false });
      const { close } = world(season.startsAt);

      await close.closeDue(after(season));

      for (const id of [closed, blocked]) {
        expect(await prisma.seasonResult.count({ where: { seasonKey: season.key, accountId: id } }), id).toBe(0);
        expect(await prisma.seasonReward.count({ where: { seasonKey: season.key, accountId: id } }), id).toBe(0);
      }
      expect(await prisma.seasonResult.findFirst({ where: { seasonKey: season.key, accountId: ordinary } })).toMatchObject({ boardSize: 1, board: "common" });
    });

    it("только внутриигровое: у награды и у начисления после claim ровно монеты и престиж, в кошельке одна запись season_reward в мягкой валюте", async () => {
      const { season, restricted } = await mixedSeason();
      const { close, claim } = world(season.startsAt);
      await close.closeDue(after(season));
      const winner = restricted[0] ?? "";
      const reward = await prisma.seasonReward.findFirst({ where: { seasonKey: season.key, accountId: winner } });
      expect(Object.keys(reward ?? {}).sort()).toEqual(["accountId", "claimedAt", "coins", "difficulty", "kind", "place", "prestige", "seasonKey", "status"]);

      const result = await claim.claim(winner, season.key, after(season, DAY));

      expect(result).toEqual({ claimed: true, credited: { coins: 1000, prestige: 100 } });
      expect(Object.keys(result.credited).sort()).toEqual(["coins", "prestige"]);
      const entries = await prisma.walletEntry.findMany({ where: { accountId: winner } });
      expect(entries.map((entry) => [entry.reason, entry.resource, Number(entry.amount)])).toEqual([["season_reward", "coins", 1000]]);
      // Ни реферальных, ни партнёрских следов у забравшего награду нет.
      expect(await prisma.referralBinding.count({ where: { OR: [{ referrerId: winner }, { referredId: winner }] } })).toBe(0);
      expect(await prisma.partnerBinding.count({ where: { accountId: winner } })).toBe(0);
    });

    it("события сезона: season_closed и season_reward_claimed без полей про доску", async () => {
      const { season, restricted } = await mixedSeason(4, 2);
      const { close, claim } = world(season.startsAt);
      const log = vi.spyOn(Logger.prototype, "log");
      await close.closeDue(after(season));
      await claim.claim(restricted[0] ?? "", season.key, after(season, DAY));

      const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"season_closed"') || line.includes('"season_reward_claimed"'));
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const payload = JSON.parse(line) as Record<string, unknown>;
        expect(Object.keys(payload).filter((key) => /board|доск|separate/i.test(key)), line).toEqual([]);
        expect(line).not.toMatch(/"board"|separate|"full"|"common"/);
      }
    });

    it("живая таблица: наложение убирает аккаунт из общей, полная его держит; снятие возвращает недельное время из базы", async () => {
      const season = await freeWeek();
      const { projection, restrictionsHooks } = world(season.startsAt);
      const [ordinary, other] = [await account("Обычный"), await account("Другой")];
      const records = [await play(ordinary, season, { survivalSec: 300 }), await play(other, season, { survivalSec: 200 })];
      for (const record of records) await projection.recorded(recorded(record));
      expect(await store.best(season.key, "easy", ordinary, "common")).toBe(300);
      expect(await store.best(season.key, "easy", ordinary, "full")).toBe(300);

      rating.separated.add(ordinary);
      const at = new Date(season.startsAt.getTime() + 2 * HOUR);
      await restrictionsHooks.emitImposed({ accountId: ordinary, kinds: ["separate_board"], at });
      expect(await store.best(season.key, "easy", ordinary, "common")).toBeNull();
      expect(await store.best(season.key, "easy", ordinary, "full")).toBe(300);
      expect(await store.count(season.key, "easy", "common")).toBe(1);
      expect(await store.count(season.key, "easy", "full")).toBe(2);

      rating.separated.delete(ordinary);
      await restrictionsHooks.emitSettled({ accountId: ordinary, kinds: ["separate_board"], at });
      expect(await store.best(season.key, "easy", ordinary, "common")).toBe(300);
      expect(await store.best(season.key, "easy", ordinary, "full")).toBe(300);
    });

    it("запись забега идёт по доскам аккаунта: с отдельной доской — только в полную", async () => {
      const season = await freeWeek();
      const { projection } = world(season.startsAt);
      const separate = await account("Отдельный");
      rating.separated.add(separate);

      await projection.recorded(recorded(await play(separate, season, { survivalSec: 350 })));

      expect(await store.best(season.key, "easy", separate, "common")).toBeNull();
      expect(await store.best(season.key, "easy", separate, "full")).toBe(350);
      expect(await redis.exists(`seasons:${season.key}:full:easy`)).toBe(1);
      expect(await redis.exists(`seasons:${season.key}:easy`)).toBe(0);
    });

    it("пересборка строит обе таблицы: общая — без аккаунтов с отдельной доской", async () => {
      const season = await freeWeek();
      const { projection } = world(season.startsAt);
      const [ordinary, separate] = [await account("Обычный"), await account("Отдельный")];
      await play(ordinary, season, { survivalSec: 200 });
      await play(separate, season, { survivalSec: 500 });
      rating.separated.add(separate);

      await projection.rebuild(new Date(season.startsAt.getTime() + 2 * HOUR));

      expect(await store.count(season.key, "easy", "common")).toBe(1);
      expect(await store.count(season.key, "easy", "full")).toBe(2);
      expect(await store.rank(season.key, "easy", separate, "full")).toBe(1);
      expect(await store.rank(season.key, "easy", ordinary, "common")).toBe(1);
    });

    it("чтение по доске зрителя: обычный видит общую без отдельных, отдельный — полную; JSON одной формы", async () => {
      const season = await freeWeek();
      const { view, projection } = world(season.startsAt);
      const [ordinary, separate] = [await account("Обычный"), await account("Отдельный")];
      rating.separated.add(separate);
      await projection.recorded(recorded(await play(ordinary, season, { survivalSec: 200 })));
      await projection.recorded(recorded(await play(separate, season, { survivalSec: 500 })));
      const now = new Date(season.startsAt.getTime() + 2 * DAY);

      const seenByOrdinary = await view.board(ordinary, { difficulty: "easy", scope: "all" }, now);
      const seenBySeparate = await view.board(separate, { difficulty: "easy", scope: "all" }, now);

      expect(seenByOrdinary.entries.map((entry) => entry.name)).toEqual(["Обычный"]);
      expect(seenByOrdinary.total).toBe(1);
      expect(seenByOrdinary.me).toEqual({ rank: 1, survivalSec: 200 });
      expect(seenBySeparate.entries.map((entry) => entry.name)).toEqual(["Отдельный", "Обычный"]);
      expect(seenBySeparate.total).toBe(2);
      expect(seenBySeparate.me).toEqual({ rank: 1, survivalSec: 500 });
      expect(Object.keys(seenByOrdinary).sort()).toEqual(Object.keys(seenBySeparate).sort());
      expect(Object.keys(seenByOrdinary.entries[0] ?? {}).sort()).toEqual(Object.keys(seenBySeparate.entries[0] ?? {}).sort());
      expect(JSON.stringify(seenByOrdinary)).not.toMatch(/board|separate|доск/i);

      const overviewOrdinary = await view.overview(ordinary, now);
      const overviewSeparate = await view.overview(separate, now);
      expect(overviewOrdinary.mine.easy).toBe(200);
      expect(overviewSeparate.mine.easy).toBe(500);
    });

    it("таблица друзей — как обычно: друг с отдельной доской виден обычному игроку с его временем, и me считается по этой же таблице", async () => {
      const season = await freeWeek();
      const { view, projection } = world(season.startsAt);
      const [me, friend] = [await account("Я"), await account("Друг с отдельной доской")];
      rating.separated.add(friend);
      expect((await friends.befriend(me, friend, "request", 100)).outcome).toBe("added");
      await projection.recorded(recorded(await play(me, season, { survivalSec: 200 })));
      await projection.recorded(recorded(await play(friend, season, { survivalSec: 700 })));
      const now = new Date(season.startsAt.getTime() + 2 * DAY);

      const mine = await view.board(me, { difficulty: "easy", scope: "friends" }, now);
      const theirs = await view.board(friend, { difficulty: "easy", scope: "friends" }, now);

      expect(mine.entries.map((entry) => [entry.rank, entry.name, entry.survivalSec])).toEqual([[1, "Друг с отдельной доской", 700], [2, "Я", 200]]);
      expect(mine.me).toEqual({ rank: 2, survivalSec: 200 });
      expect(theirs.entries.map((entry) => entry.name)).toEqual(["Друг с отдельной доской", "Я"]);
      expect(theirs.me).toEqual({ rank: 1, survivalSec: 700 });
    });

    it("вкладка «Друзья» у зрителя с молчаливым ограничением: me считается по той же таблице, что в ответе, а не по общей недели", async () => {
      const season = await freeWeek();
      const { view, projection } = world(season.startsAt);
      const [shadow, friend, stranger] = [await account("Тень"), await account("Друг"), await account("Чужой")];
      expect((await friends.befriend(shadow, friend, "request", 100)).outcome).toBe("added");
      await projection.recorded(recorded(await play(friend, season, { survivalSec: 300 })));
      await projection.recorded(recorded(await play(stranger, season, { survivalSec: 900 })));
      await play(shadow, season, { survivalSec: 600, ranked: false, ratingRestricted: "silent" });
      restrictions.restricted.set(shadow, { notify: false });
      const now = new Date(season.startsAt.getTime() + 2 * DAY);

      const board = await view.board(shadow, { difficulty: "easy", scope: "friends" }, now);

      // Среди друзей (он сам и друг) его 600 — первое место; по общей недели было бы второе после чужого.
      expect(board.me).toEqual({ rank: 1, survivalSec: 600 });
      expect(board.total).toBe(2);
      const all = await view.board(shadow, { difficulty: "easy", scope: "all" }, now);
      expect(all.me).toEqual({ rank: 2, survivalSec: 600 });
    });
  });

  describe("награда", () => {
    async function closedWith(count = 12) {
      const crowd = await crowdedSeason(count);
      const services = world(crowd.season.startsAt);
      await services.close.closeDue(after(crowd.season));
      return { ...crowd, ...services };
    }

    it("claim: pending → claimed, монеты в кошельке один раз, повтор — claimed: false и нули", async () => {
      const { season, players, claim } = await closedWith();
      const winner = players[0] ?? "";
      const balanceBefore = (await wallet.balances(winner)).coins;

      const first = await claim.claim(winner, season.key, after(season, DAY));
      const again = await claim.claim(winner, season.key, after(season, DAY));

      expect(first).toEqual({ claimed: true, credited: { coins: 1000, prestige: 100 } });
      expect(again).toEqual({ claimed: false, credited: { coins: 0, prestige: 0 } });
      expect(claimResultSchema.parse(first)).toEqual(first);
      expect((await wallet.balances(winner)).coins - balanceBefore).toBe(1000);
      expect(await prisma.walletEntry.count({ where: { accountId: winner, idempotencyKey: `season:${season.key}:${winner}` } })).toBe(1);
      expect(await prisma.seasonReward.findFirst({ where: { seasonKey: season.key, accountId: winner } })).toMatchObject({ status: "claimed" });
    });

    it("два claim параллельно — одно начисление", async () => {
      const { season, players, claim } = await closedWith();
      const id = players[1] ?? "";
      const balanceBefore = (await wallet.balances(id)).coins;

      const outcomes = await Promise.all(Array.from({ length: 5 }, () => claim.claim(id, season.key, after(season, DAY))));

      expect(outcomes.filter((outcome) => outcome.claimed)).toHaveLength(1);
      expect((await wallet.balances(id)).coins - balanceBefore).toBe(600);
      expect(await prisma.walletEntry.count({ where: { accountId: id, reason: "season_reward", source: `season:${season.key}` } })).toBe(1);
    });

    it("чужой аккаунт и несуществующая награда — 404 season_reward_not_found", async () => {
      const { season, claim } = await closedWith(3);
      const stranger = await account();

      await expect(claim.claim(stranger, season.key, after(season))).rejects.toMatchObject({ code: "season_reward_not_found", status: 404 });
      await expect(claim.claim(stranger, "2099-12-28", after(season))).rejects.toBeInstanceOf(DomainError);
    });

    it("множитель сложности и округление совпадают с placeReward", async () => {
      const season = await freeWeek();
      const { close, claim } = world(season.startsAt);
      const players: string[] = [];
      for (let index = 0; index < 10; index++) {
        const id = await account();
        players.push(id);
        await play(id, season, { difficulty: "hard", survivalSec: 400 - index * 10 });
      }
      await close.closeDue(after(season));

      const tenth = await claim.claim(players[9] ?? "", season.key, after(season));

      expect(tenth.credited).toEqual(placeReward(10, 10, "hard"));
      expect(tenth.credited).toEqual({ coins: 680, prestige: 43 });
    });

    it("остаток кошелька сходится с журналом", async () => {
      const { season, players, claim } = await closedWith();
      const id = players[3] ?? "";
      await claim.claim(id, season.key, after(season));

      const entries = await prisma.walletEntry.findMany({ where: { accountId: id, resource: "coins" } });
      const balance = await prisma.walletBalance.findUnique({ where: { accountId_resource: { accountId: id, resource: "coins" } } });

      expect(entries.reduce((sum, entry) => sum + Number(entry.amount), 0)).toBe(Number(balance?.balance ?? 0));
    });
  });

  describe("чтение", () => {
    it("GET /seasons при пустой настройке: сезонов нет, списки пусты, правила наград на месте", async () => {
      const { view } = world(null);
      const id = await account();

      const answer = await view.overview(id, new Date());

      expect(overviewSchema.parse(answer)).toEqual(answer);
      expect(answer).toMatchObject({ enabled: false, startsAt: null, season: null, pending: [], history: [], minBoard: 10 });
      expect(answer.thresholds).toEqual({ easy: 180, normal: 150, hard: 90 });
      expect(answer.placeLadder[0]).toEqual({ fromPlace: 1, toPlace: 1, coins: 1000, prestige: 100 });
      expect(answer.mine).toEqual({ easy: null, normal: null, hard: null });
    });

    it("дата первого сезона в будущем: enabled, сезона нет, startsAt называет понедельник", async () => {
      const { view } = world(new Date("2031-03-03T00:00:00Z"));

      const answer = await view.overview(await account(), new Date("2031-02-25T10:00:00Z"));

      expect(answer).toMatchObject({ enabled: true, season: null, startsAt: "2031-03-03T00:00:00.000Z", pending: [], history: [] });
    });

    it("идущий сезон: ключ, границы, секунды до конца и моё лучшее время недели", async () => {
      const season = await freeWeek();
      const { view, projection } = world(season.startsAt);
      const id = await account();
      await projection.recorded(recorded(await play(id, season, { survivalSec: 222 })));
      const now = new Date(season.endsAt.getTime() - 3_600_000);

      const answer = await view.overview(id, now);

      expect(answer.season).toEqual({ key: season.key, startsAt: season.startsAt.toISOString(), endsAt: season.endsAt.toISOString(), secondsLeft: 3_600 });
      expect(answer.mine).toEqual({ easy: 222, normal: null, hard: null });
    });

    it("после закрытия: награда ждёт в pending, история — результаты и награда; забрал — claimed: true, pending пуст", async () => {
      const { season, players } = await crowdedSeason();
      const { close, claim, view } = world(season.startsAt);
      await close.closeDue(after(season));
      const id = players[0] ?? "";
      const now = after(season, DAY);

      const before = await view.overview(id, now);
      expect(overviewSchema.parse(before)).toEqual(before);
      expect(before.pending).toEqual([{ seasonKey: season.key, kind: "place", difficulty: "easy", place: 1, coins: 1000, prestige: 100 }]);
      expect(before.history).toEqual([
        {
          seasonKey: season.key,
          startsAt: season.startsAt.toISOString(),
          endsAt: season.endsAt.toISOString(),
          results: [{ difficulty: "easy", bestSec: 500, place: 1, boardSize: 12 }],
          reward: { coins: 1000, prestige: 100, claimed: false },
        },
      ]);

      await claim.claim(id, season.key, now);
      const afterClaim = await view.overview(id, now);
      expect(afterClaim.pending).toEqual([]);
      expect(afterClaim.history[0]?.reward).toEqual({ coins: 1000, prestige: 100, claimed: true });
    });

    it("история — не больше восьми закрытых сезонов, свежие первыми", async () => {
      const base = await freeWeek(11);
      const { close, view } = world(base.startsAt);
      const id = await account();
      for (let week = 0; week < 10; week++) {
        const season = seasonOf(new Date(base.startsAt.getTime() + week * 7 * DAY));
        await play(id, season, { survivalSec: 200 + week });
      }
      // Задание закрытия догоняет не больше двух недель (MAX_CATCH_UP_WEEKS): закрываем неделя за неделей, как в жизни.
      for (let week = 1; week <= 10; week++) await close.closeDue(new Date(base.startsAt.getTime() + week * 7 * DAY + HOUR));

      const answer = await view.overview(id, new Date(base.startsAt.getTime() + 11 * 7 * DAY));

      expect(answer.history).toHaveLength(8);
      expect(answer.history[0]?.seasonKey).toBe(seasonOf(new Date(base.startsAt.getTime() + 9 * 7 * DAY)).key);
      expect(answer.history[7]?.seasonKey).toBe(seasonOf(new Date(base.startsAt.getTime() + 2 * 7 * DAY)).key);
    });

    it("таблица недели: места из Redis, подробности лучшего забега недели, себя помечает, чужие идентификаторы наружу не уходят", async () => {
      const season = await freeWeek();
      const { view, projection } = world(season.startsAt);
      const [fast, slow] = [await account("Быстрый"), await account("Медленный")];
      await projection.recorded(recorded(await play(fast, season, { survivalSec: 400, level: 11, enemiesKilled: 900 })));
      await projection.recorded(recorded(await play(slow, season, { survivalSec: 100, level: 3 })));
      // Рекорд прошлой недели в подробности недели не попадает.
      await play(slow, season, { survivalSec: 999, offsetMs: -DAY });
      const now = new Date(season.startsAt.getTime() + 2 * DAY);

      const board = await view.board(slow, { difficulty: "easy", scope: "all" }, now);

      expect(boardViewSchema.parse(board)).toEqual(board);
      expect(board.seasonKey).toBe(season.key);
      expect(board.total).toBe(2);
      expect(board.entries.map((entry) => [entry.rank, entry.name, entry.survivalSec, entry.level, entry.isMe])).toEqual([
        [1, "Быстрый", 400, 11, false],
        [2, "Медленный", 100, 3, true],
      ]);
      expect(board.me).toEqual({ rank: 2, survivalSec: 100 });
      expect(JSON.stringify(board)).not.toContain(fast);
    });

    it("таблица друзей: только принятые друзья и сам игрок; заявка и чужие не в счёт", async () => {
      const season = await freeWeek();
      const { view, projection } = world(season.startsAt);
      const [me, friend, stranger, requested] = [await account("Я"), await account("Друг"), await account("Чужой"), await account("Заявка")];
      expect((await friends.befriend(me, friend, "request", 100)).outcome).toBe("added");
      expect(await friends.request(me, requested, { maxIncoming: 50, maxOutgoing: 50 })).toBe("sent");
      for (const [id, sec] of [
        [me, 200],
        [friend, 300],
        [stranger, 900],
        [requested, 800],
      ] as const) {
        await projection.recorded(recorded(await play(id, season, { survivalSec: sec })));
      }
      const now = new Date(season.startsAt.getTime() + 2 * DAY);

      const board = await view.board(me, { difficulty: "easy", scope: "friends" }, now);

      expect(board.entries.map((entry) => [entry.rank, entry.name])).toEqual([
        [1, "Друг"],
        [2, "Я"],
      ]);
      expect(board.total).toBe(2);
      expect(board.me).toEqual({ rank: 2, survivalSec: 200 });
      const everyone = await view.board(me, { difficulty: "easy", scope: "all" }, now);
      expect(everyone.total).toBe(4);
    });

    it("таблица без сезона: пустые записи и seasonKey null", async () => {
      const { view } = world(null);

      const board = await view.board(await account(), { difficulty: "easy", scope: "all" }, new Date());

      expect(board).toEqual({ seasonKey: null, difficulty: "easy", total: 0, entries: [], me: null });
    });

    it("молчаливое ограничение: игрок видит своё место в таблице из тени, а другие его нет", async () => {
      const season = await freeWeek();
      const { view, projection } = world(season.startsAt);
      const [honest, shadow] = [await account("Честный"), await account("Тень")];
      await projection.recorded(recorded(await play(honest, season, { survivalSec: 200 })));
      await play(shadow, season, { survivalSec: 600, ranked: false, ratingRestricted: "silent" });
      restrictions.restricted.set(shadow, { notify: false });
      const now = new Date(season.startsAt.getTime() + 2 * DAY);

      const own = await view.board(shadow, { difficulty: "easy", scope: "all" }, now);
      const other = await view.board(honest, { difficulty: "easy", scope: "all" }, now);

      expect(own.me).toEqual({ rank: 1, survivalSec: 600 });
      expect(other.entries.map((entry) => entry.name)).toEqual(["Честный"]);
      expect(other.total).toBe(1);
    });
  });
});
