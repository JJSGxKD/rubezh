import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { rebuildLeaderboard } from "../src/modules/runs/leaderboard-rebuild.js";
import { RedisLeaderboardStore } from "../src/modules/runs/leaderboard.store.js";
import { PrismaRunsRepository, type RunFinishRecord } from "../src/modules/runs/runs.repository.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Забеги на настоящих Postgres и Redis (docs/17-testing-strategy.md §4.2).
 * Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL; без них пропускается.
 *
 * Память этого не покажет: два одновременных итога одного забега упираются в
 * первичный ключ базы, `ZADD GT` не опускает рекорд на стороне Redis, а
 * пересборка подменяет рейтинг одной командой.
 *
 * Redis — своя база (сдвиг 2): ключи рейтинга общие на сложность, и делить
 * их с соседними файлами тестов нельзя.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 2);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

describe.skipIf(!live)("забеги на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let runs: PrismaRunsRepository;
  let board: RedisLeaderboardStore;
  let accounts: PrismaAccountRepository;

  async function account(name = "Дым"): Promise<string> {
    const created = await accounts.upsert(
      { platform: "telegram", platformUserId: String(900_000_000 + Math.floor(Math.random() * 90_000_000)), displayName: name, username: null, photoUrl: null },
      Date.now(),
    );
    return created.accountId;
  }

  function finished(runId: string, accountId: string, patch: Partial<RunFinishRecord> = {}): RunFinishRecord {
    return {
      runId,
      accountId,
      difficulty: "hard",
      startingWeaponId: "knife",
      contentHash: "abc",
      finishedAt: new Date(),
      outcome: "died",
      survivalSec: 120,
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
      ...patch,
    };
  }

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    // База своя у этого файла — очищать её можно.
    await redis.flushdb();
    runs = new PrismaRunsRepository(prisma);
    board = new RedisLeaderboardStore(redis);
    accounts = new PrismaAccountRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  it("два одновременных итога одного забега — записан ровно один", async () => {
    const accountId = await account();
    const runId = randomUUID();

    const outcomes = await Promise.all([runs.finish(finished(runId, accountId)), runs.finish(finished(runId, accountId))]);

    expect([...outcomes].sort()).toEqual(["duplicate", "finished"]);
    expect(await prisma.run.count({ where: { runId } })).toBe(1);
  });

  it("то же с состоявшимся стартом: условие на статус пропускает одного", async () => {
    const accountId = await account();
    const runId = randomUUID();
    await runs.start({ runId, accountId, difficulty: "hard", startingWeaponId: "knife", contentHash: "abc", startedAt: new Date() });

    const outcomes = await Promise.all([runs.finish(finished(runId, accountId)), runs.finish(finished(runId, accountId))]);

    expect([...outcomes].sort()).toEqual(["duplicate", "finished"]);
    expect((await runs.find(runId))?.startedAt).not.toBeNull();
  });

  it("чужой ключ забега виден как чужой", async () => {
    const [owner, stranger] = [await account(), await account()];
    const runId = randomUUID();
    await runs.finish(finished(runId, owner));

    expect(await runs.finish(finished(runId, stranger))).toBe("foreign");
  });

  it("рекорд в Redis только растёт", async () => {
    const accountId = await account();

    expect(await board.submit("easy", accountId, 200)).toEqual({ improved: true });
    expect(await board.submit("easy", accountId, 100)).toEqual({ improved: false });
    expect(await board.submit("easy", accountId, 200)).toEqual({ improved: false });
    expect(await board.best("easy", accountId)).toBe(200);
  });

  it("лучший забег каждого — одним запросом, с именем из аккаунта", async () => {
    const accountId = await account("Анна");
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "normal", survivalSec: 90, level: 5 }));
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "normal", survivalSec: 250, level: 11 }));
    // Не рейтинговый — не должен попасть, даже если он лучше.
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "normal", survivalSec: 999, ranked: false }));

    const [best] = await runs.bestRuns([accountId], "normal");

    expect(best).toMatchObject({ displayName: "Анна", survivalSec: 250, level: 11 });
  });

  it("пересборка ставит рейтинг по базе и подменяет его целиком", async () => {
    const [slow, fast] = [await account(), await account()];
    await runs.finish(finished(randomUUID(), slow, { difficulty: "easy", survivalSec: 100 }));
    await runs.finish(finished(randomUUID(), fast, { difficulty: "easy", survivalSec: 500 }));
    // Мусор в проекции, которого в базе нет, — пересборка его уберёт.
    await redis.zadd("runs:leaderboard:easy", 99_999, "призрак");

    await rebuildLeaderboard(runs, board, new Set());

    expect(await board.rank("easy", "призрак")).toBeNull();
    expect((await board.rank("easy", fast)) ?? 0).toBeLessThan((await board.rank("easy", slow)) ?? 0);
    expect(await redis.exists("runs:leaderboard:easy:rebuild")).toBe(0);
  });

  it("ограничение рейтинга: лучший для возврата — только рейтинговые, для тени — и сданные молча; база держит пометку только у нерейтингового", async () => {
    const accountId = await account("Тень");
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "easy", survivalSec: 200 }));
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "easy", survivalSec: 400, ranked: false, ratingRestricted: "silent" }));
    const told = randomUUID();
    await runs.finish(finished(told, accountId, { difficulty: "easy", survivalSec: 900, ranked: false, ratingRestricted: "notified" }));

    expect(await runs.bestRunOf(accountId, "easy", false)).toMatchObject({ displayName: "Тень", survivalSec: 200 });
    expect(await runs.bestRunOf(accountId, "easy", true)).toMatchObject({ survivalSec: 400 });
    expect(await runs.bestRunOf(accountId, "normal", true)).toBeNull();
    expect(await runs.find(told)).toMatchObject({ ranked: false, ratingRestricted: "notified" });
    expect(await runs.detail(accountId, told)).toMatchObject({ ratingRestricted: "notified" });

    await expect(runs.finish(finished(randomUUID(), accountId, { ranked: true, ratingRestricted: "silent" }))).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE run SET rating_restricted = 'shadow' WHERE run_id = ${told}`).rejects.toThrow();
  });

  it("доска: место того, кого в ней нет, — по строго лучшим; убрать — из всех сложностей разом", async () => {
    const [fast, slow, gone] = [await account(), await account(), await account()];
    await board.submit("normal", fast, 500);
    await board.submit("normal", slow, 300);
    await board.submit("normal", gone, 400);
    await board.submit("hard", gone, 100);

    expect(await board.countAbove("normal", 400)).toBe(1);
    expect(await board.countAbove("normal", 300)).toBe(2);
    expect(await board.remove([gone, "никого-нет"])).toBe(2);
    expect(await board.best("normal", gone)).toBeNull();
    expect(await board.best("hard", gone)).toBeNull();
    expect(await board.remove([])).toBe(0);
  });

  it("снять с рейтинга модератором: только рейтинговый, вернуть — только снятый им; два нажатия разом меняют однажды", async () => {
    // Пересборка в соседнем тесте читает всю базу, а доска «normal» там считается поштучно — здесь «easy».
    const accountId = await account("Рекорд");
    const [record, second, cheats, restricted] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await runs.finish(finished(record, accountId, { difficulty: "easy", survivalSec: 700 }));
    await runs.finish(finished(second, accountId, { difficulty: "easy", survivalSec: 300 }));
    await runs.finish(finished(cheats, accountId, { difficulty: "easy", survivalSec: 900, ranked: false, cheats: true }));
    await runs.finish(finished(restricted, accountId, { difficulty: "easy", survivalSec: 800, ranked: false, ratingRestricted: "notified" }));

    const [first, repeat] = await Promise.all([runs.setRanked(record, false), runs.setRanked(record, false)]);
    expect([first, repeat].filter((changed) => changed !== null)).toEqual([{ accountId, difficulty: "easy", survivalSec: 700 }]);
    expect(await runs.bestRunOf(accountId, "easy", false)).toMatchObject({ survivalSec: 300 });
    // В списке модератора — рейтинговые и снятые им, без забегов с читами и под ограничением.
    expect((await runs.moderationRuns(accountId, "easy", 10)).map((row) => [row.runId, row.ranked])).toEqual([
      [record, false],
      [second, true],
    ]);

    expect(await runs.setRanked(cheats, true)).toBeNull();
    expect(await runs.setRanked(restricted, true)).toBeNull();
    expect(await runs.setRanked(record, true)).toMatchObject({ survivalSec: 700 });
    expect(await runs.bestRunOf(accountId, "easy", false)).toMatchObject({ survivalSec: 700 });

    // Точная запись в доску опускает время — после снятия рекорда.
    await board.submit("easy", accountId, 700);
    await board.set("easy", accountId, 300);
    expect(await board.best("easy", accountId)).toBe(300);
    await board.set("easy", accountId, null);
    expect(await board.best("easy", accountId)).toBeNull();
  });

  it("очередь разбора видит отклонённые и подозрительные, а честные — нет", async () => {
    const accountId = await account();
    const flagged = randomUUID();
    await runs.finish(finished(flagged, accountId, { verdict: "rejected", ranked: false, verdictReasons: ["weapons_over_slots"] }));
    await runs.finish(finished(randomUUID(), accountId));

    const queue = await runs.review(200);

    expect(queue.some((row) => row.runId === flagged && row.verdictReasons.includes("weapons_over_slots"))).toBe(true);
    expect(queue.every((row) => row.verdict !== "ok")).toBe(true);
  });

  it("лист забега: подробности и урон оружия — из базы, чужой — `null`, битый JSON — без этой части", async () => {
    const [owner, stranger] = [await account(), await account()];
    const runId = randomUUID();
    const details = { passives: [{ id: "might", level: 2 }], damageTaken: 310, xpCollected: 95, waveReached: 4, topKills: [{ enemy: "swarm_rat", count: 200 }] };
    await runs.finish(finished(runId, owner, { weapons: [{ id: "knife", level: 3, damage: 4200 }], details }));

    expect(await runs.detail(owner, runId)).toMatchObject({ weapons: [{ id: "knife", level: 3, damage: 4200 }], details, continues: 0 });
    expect(await runs.detail(stranger, runId)).toBeNull();
    expect((await runs.recent(owner, 5)).map((run) => run.runId)).toEqual([runId]);

    // Строка прошлой сборки без урона и подробностей.
    const old = randomUUID();
    await runs.finish(finished(old, owner));
    expect(await runs.detail(owner, old)).toMatchObject({ weapons: [{ id: "knife", level: 2, damage: null }], details: null });

    await prisma.run.update({ where: { runId }, data: { details: { passives: "битые" }, weapons: { не: "массив" } } });
    expect(await runs.detail(owner, runId)).toMatchObject({ weapons: [], details: null });
  });
});
