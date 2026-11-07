import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { rebuildForRestrictions, rebuildLeaderboard } from "../src/modules/runs/leaderboard-rebuild.js";
import { ALL_BOARDS, COMMON_ONLY, RedisLeaderboardStore } from "../src/modules/runs/leaderboard.store.js";
import { PrismaRunsRepository, type RunFinishRecord } from "../src/modules/runs/runs.repository.js";
import { secondsScore } from "./helpers/memory-runs.js";
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
const NO_COUNTERS = { bossKills: null, eliteKills: null, chestsOpened: null, crystals: null, noHitSec: null, noKillSec: null, killsByElement: null };

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
      rubezhReached: false,
      rubezhClearedSec: null,
      // Доска ранжирует по очкам (T-0294): в тестах очки равны секундам, если забегу не заданы свои.
      score: secondsScore(patch.survivalSec ?? 120),
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

    expect(await board.submit("easy", accountId, 200, ALL_BOARDS)).toEqual({ improved: true });
    expect(await board.submit("easy", accountId, 100, ALL_BOARDS)).toEqual({ improved: false });
    expect(await board.submit("easy", accountId, 200, ALL_BOARDS)).toEqual({ improved: false });
    expect(await board.best("easy", accountId, "common")).toBe(200);
  });

  it("лучший забег каждого — одним запросом, с именем из аккаунта", async () => {
    const accountId = await account("Анна");
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "hard", survivalSec: 90, level: 5 }));
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "hard", survivalSec: 250, level: 11 }));
    // Не рейтинговый — не должен попасть, даже если он лучше.
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "hard", survivalSec: 999, ranked: false }));

    const [best] = await runs.bestRuns([accountId], "hard", null);

    expect(best).toMatchObject({ displayName: "Анна", survivalSec: 250, level: 11 });
  });

  it("знак «Тестер» (T-0042): у аккаунта с testerAt в лучшем забеге tester: true, у остальных поля нет, а сама дата наружу не уходит", async () => {
    const tester = await account("Тестер");
    const plain = await account("Обычный");
    await prisma.account.update({ where: { accountId: tester }, data: { testerAt: new Date("2026-10-01T10:00:00Z") } });
    for (const id of [tester, plain]) await runs.finish(finished(randomUUID(), id, { difficulty: "hard", survivalSec: 120 }));

    const rows = await runs.bestRuns([tester, plain], "hard", null);
    const byId = new Map(rows.map((row) => [row.accountId, row]));

    expect(byId.get(tester)).toMatchObject({ displayName: "Тестер", tester: true });
    expect(byId.get(plain)).not.toHaveProperty("tester");
    for (const row of rows) expect(row).not.toHaveProperty("testerAt");
  });

  it("знак «Тестер»: bestRunOf — то же правило, в том числе для тени", async () => {
    const tester = await account("Тестер в тени");
    const plain = await account("Обычный в тени");
    await prisma.account.update({ where: { accountId: tester }, data: { testerAt: new Date("2026-10-01T10:00:00Z") } });
    for (const id of [tester, plain]) await runs.finish(finished(randomUUID(), id, { difficulty: "hard", survivalSec: 80 }));
    await runs.finish(finished(randomUUID(), tester, { difficulty: "hard", survivalSec: 300, ranked: false, ratingRestricted: "silent" }));

    expect(await runs.bestRunOf(tester, "hard", false, null)).toMatchObject({ tester: true, survivalSec: 80 });
    expect(await runs.bestRunOf(tester, "hard", true, null)).toMatchObject({ tester: true, survivalSec: 300 });
    expect(await runs.bestRunOf(plain, "hard", false, null)).not.toHaveProperty("tester");
    expect(await runs.bestRunOf(tester, "hard", false, null)).not.toHaveProperty("testerAt");
  });

  it("пересборка ставит рейтинг по базе и подменяет его целиком", async () => {
    const [slow, fast] = [await account(), await account()];
    await runs.finish(finished(randomUUID(), slow, { difficulty: "hard", survivalSec: 100 }));
    await runs.finish(finished(randomUUID(), fast, { difficulty: "hard", survivalSec: 500 }));
    // Мусор в проекции, которого в базе нет, — пересборка его уберёт.
    await redis.zadd("runs:leaderboard:pts:hard", 99_999, "призрак");

    await rebuildLeaderboard(runs, board, new Set(), new Set(), null);

    expect(await board.rank("hard", "призрак", "common")).toBeNull();
    expect((await board.rank("hard", fast, "common")) ?? 0).toBeLessThan((await board.rank("hard", slow, "common")) ?? 0);
    expect(await redis.exists("runs:leaderboard:pts:hard:rebuild")).toBe(0);
  });

  it("ограничение рейтинга: лучший для возврата — только рейтинговые, для тени — и сданные молча; база держит пометку только у нерейтингового", async () => {
    const accountId = await account("Тень");
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "hard", survivalSec: 200 }));
    await runs.finish(finished(randomUUID(), accountId, { difficulty: "hard", survivalSec: 400, ranked: false, ratingRestricted: "silent" }));
    const told = randomUUID();
    await runs.finish(finished(told, accountId, { difficulty: "hard", survivalSec: 900, ranked: false, ratingRestricted: "notified" }));

    expect(await runs.bestRunOf(accountId, "hard", false, null)).toMatchObject({ displayName: "Тень", survivalSec: 200 });
    expect(await runs.bestRunOf(accountId, "hard", true, null)).toMatchObject({ survivalSec: 400 });
    expect(await runs.bestRunOf(accountId, "normal", true, null)).toBeNull();
    expect(await runs.find(told)).toMatchObject({ ranked: false, ratingRestricted: "notified" });
    expect(await runs.detail(accountId, told)).toMatchObject({ ratingRestricted: "notified" });

    await expect(runs.finish(finished(randomUUID(), accountId, { ranked: true, ratingRestricted: "silent" }))).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE run SET rating_restricted = 'shadow' WHERE run_id = ${told}`).rejects.toThrow();
  });

  it("доска: место того, кого в ней нет, — по строго лучшим; убрать — из всех сложностей разом", async () => {
    const [fast, slow, gone] = [await account(), await account(), await account()];
    await board.submit("normal", fast, 500, COMMON_ONLY);
    await board.submit("normal", slow, 300, COMMON_ONLY);
    await board.submit("normal", gone, 400, COMMON_ONLY);
    await board.submit("hard", gone, 100, COMMON_ONLY);

    expect(await board.countAbove("normal", 400, "common")).toBe(1);
    expect(await board.countAbove("normal", 300, "common")).toBe(2);
    expect(await board.remove([gone, "никого-нет"], COMMON_ONLY)).toBe(2);
    expect(await board.best("normal", gone, "common")).toBeNull();
    expect(await board.best("hard", gone, "common")).toBeNull();
    expect(await board.remove([], COMMON_ONLY)).toBe(0);
  });

  it("снять с рейтинга модератором: только рейтинговый, вернуть — только снятый им; два нажатия разом меняют однажды", async () => {
    // Проверки ниже — по аккаунту, а не по всей базе: забеги соседних тестов на единой сложности им не мешают.
    const accountId = await account("Рекорд");
    const [record, second, cheats, restricted] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await runs.finish(finished(record, accountId, { difficulty: "hard", survivalSec: 700 }));
    await runs.finish(finished(second, accountId, { difficulty: "hard", survivalSec: 300 }));
    await runs.finish(finished(cheats, accountId, { difficulty: "hard", survivalSec: 900, ranked: false, cheats: true }));
    await runs.finish(finished(restricted, accountId, { difficulty: "hard", survivalSec: 800, ranked: false, ratingRestricted: "notified" }));

    const [first, repeat] = await Promise.all([runs.setRanked(record, false, null), runs.setRanked(record, false, null)]);
    expect([first, repeat].filter((changed) => changed !== null)).toEqual([{ accountId, difficulty: "hard", survivalSec: 700 }]);
    expect(await runs.bestRunOf(accountId, "hard", false, null)).toMatchObject({ survivalSec: 300 });
    // В списке модератора — рейтинговые и снятые им, без забегов с читами и под ограничением.
    expect((await runs.moderationRuns(accountId, "hard", 10, null)).map((row) => [row.runId, row.ranked])).toEqual([
      [record, false],
      [second, true],
    ]);

    expect(await runs.setRanked(cheats, true, null)).toBeNull();
    expect(await runs.setRanked(restricted, true, null)).toBeNull();
    expect(await runs.setRanked(record, true, null)).toMatchObject({ survivalSec: 700 });
    expect(await runs.bestRunOf(accountId, "hard", false, null)).toMatchObject({ survivalSec: 700 });

    // Точная запись в доску опускает время — после снятия рекорда.
    await board.submit("easy", accountId, 700, ALL_BOARDS);
    await board.set("easy", accountId, 300, ALL_BOARDS);
    expect(await board.best("easy", accountId, "common")).toBe(300);
    await board.set("easy", accountId, null, ALL_BOARDS);
    expect(await board.best("easy", accountId, "common")).toBeNull();
  });

  it("две доски: запись по списку досок, ZADD GT на каждой, improved — если изменилась хоть одна", async () => {
    await redis.flushdb();
    const [onlyFull, both] = [await account(), await account()];

    expect(await board.submit("normal", onlyFull, 300, ["full"])).toEqual({ improved: true });
    // Общего ключа не появилось: пишется только в полную.
    expect(await redis.exists("runs:leaderboard:pts:normal")).toBe(0);
    expect(await redis.zscore("runs:leaderboard:pts:full:normal", onlyFull)).toBe("300");
    expect(await board.best("normal", onlyFull, "common")).toBeNull();

    expect(await board.submit("normal", both, 200, ALL_BOARDS)).toEqual({ improved: true });
    expect(await board.best("normal", both, "full")).toBe(200);
    expect(await board.best("normal", both, "common")).toBe(200);
    expect(await redis.zscore("runs:leaderboard:pts:normal", both)).toBe("200");

    // GT на каждой доске: худшее и равное время ничего не меняют.
    expect(await board.submit("normal", both, 150, ALL_BOARDS)).toEqual({ improved: false });
    expect(await board.submit("normal", onlyFull, 300, ["full"])).toEqual({ improved: false });
    expect(await board.submit("normal", onlyFull, 400, ["full"])).toEqual({ improved: true });
    expect(await board.best("normal", both, "common")).toBe(200);

    // Доски разошлись (общая отстала): запись в обе улучшает хотя бы одну — `improved`.
    await board.submit("normal", onlyFull, 500, ["full"]);
    expect(await board.submit("normal", onlyFull, 500, ALL_BOARDS)).toEqual({ improved: true });
    expect(await board.best("normal", onlyFull, "common")).toBe(500);
    expect(await board.submit("normal", onlyFull, 500, ALL_BOARDS)).toEqual({ improved: false });
  });

  it("две доски: место, размер, строго лучшие и верх считаются каждой своей", async () => {
    await redis.flushdb();
    const [a, b, c] = [await account(), await account(), await account()];
    await board.submit("hard", a, 400, ["full"]);
    await board.submit("hard", b, 200, ALL_BOARDS);
    await board.submit("hard", c, 100, ["common"]);

    expect(await board.count("hard", "full")).toBe(2);
    expect(await board.count("hard", "common")).toBe(2);
    expect(await board.rank("hard", b, "full")).toBe(2);
    expect(await board.rank("hard", b, "common")).toBe(1);
    expect(await board.rank("hard", a, "common")).toBeNull();
    expect(await board.rank("hard", c, "full")).toBeNull();
    expect(await board.countAbove("hard", 150, "full")).toBe(2);
    expect(await board.countAbove("hard", 150, "common")).toBe(1);
    expect((await board.top("hard", 10, "full")).map((entry) => [entry.accountId, entry.score])).toEqual([
      [a, 400],
      [b, 200],
    ]);
    expect((await board.top("hard", 10, "common")).map((entry) => [entry.accountId, entry.score])).toEqual([
      [b, 200],
      [c, 100],
    ]);
    expect(await board.top("easy", 10, "common")).toEqual([]);
  });

  it("две доски: точная запись и снятие идут по списку досок", async () => {
    await redis.flushdb();
    const accountId = await account();
    await board.submit("easy", accountId, 700, ALL_BOARDS);

    // Рекорд снят модератором у аккаунта с отдельной доской — правится только полная.
    await board.set("easy", accountId, 300, ["full"]);
    expect(await board.best("easy", accountId, "full")).toBe(300);
    expect(await board.best("easy", accountId, "common")).toBe(700);
    await board.set("easy", accountId, null, ["full"]);
    expect(await board.best("easy", accountId, "full")).toBeNull();
    expect(await board.best("easy", accountId, "common")).toBe(700);
  });

  it("две доски: убрать из общей не трогает полную, число — сколько мест снято", async () => {
    await redis.flushdb();
    const [stays, goes] = [await account(), await account()];
    await board.submit("normal", stays, 100, ALL_BOARDS);
    await board.submit("normal", goes, 200, ALL_BOARDS);
    await board.submit("hard", goes, 300, ALL_BOARDS);

    expect(await board.remove([goes, "никого-нет"], COMMON_ONLY)).toBe(2);
    expect(await board.best("normal", goes, "common")).toBeNull();
    expect(await board.best("hard", goes, "common")).toBeNull();
    expect(await board.best("normal", goes, "full")).toBe(200);
    expect(await board.best("hard", goes, "full")).toBe(300);
    expect(await board.best("normal", stays, "common")).toBe(100);

    expect(await board.remove([goes], ALL_BOARDS)).toBe(2);
    expect(await board.best("normal", goes, "full")).toBeNull();
    expect(await board.remove([goes], COMMON_ONLY)).toBe(0);
    expect(await board.remove([], ALL_BOARDS)).toBe(0);
  });

  it("две доски: замена одной оставляет чужую нетронутой и не оставляет временного ключа", async () => {
    await redis.flushdb();
    const [a, b] = [await account(), await account()];
    await board.submit("normal", a, 100, ALL_BOARDS);

    await board.replace("normal", "full", [{ accountId: b, score: 900 }]);

    expect((await board.top("normal", 10, "full")).map((entry) => entry.accountId)).toEqual([b]);
    expect((await board.top("normal", 10, "common")).map((entry) => entry.accountId)).toEqual([a]);
    expect(await redis.keys("runs:leaderboard:pts:*:rebuild")).toEqual([]);
    expect(await redis.keys("runs:leaderboard:pts:rebuild*")).toEqual([]);

    await board.replace("normal", "common", []);
    expect(await board.count("normal", "common")).toBe(0);
    expect(await board.count("normal", "full")).toBe(1);
    expect(await redis.keys("*:rebuild")).toEqual([]);
  });

  it("пересборка из базы: полная — все рейтинговые без закрытых, общая — ещё и без отдельной доски; счётчики по доскам", async () => {
    const [closed, separate, plain] = [await account("Закрытый"), await account("Отдельная"), await account("Обычный")];
    for (const id of [closed, separate, plain]) await runs.finish(finished(randomUUID(), id, { difficulty: "hard", survivalSec: 640 }));
    // Мусор, которого в базе нет, уходит из обеих проекций.
    await redis.zadd("runs:leaderboard:pts:hard", 99_999, "призрак");
    await redis.zadd("runs:leaderboard:pts:full:hard", 99_999, "призрак");

    const counts = await rebuildLeaderboard(runs, board, new Set([closed]), new Set([separate]), null);

    for (const side of ALL_BOARDS) {
      expect(await board.best("hard", closed, side)).toBeNull();
      expect(await board.best("hard", "призрак", side)).toBeNull();
      expect(await board.best("hard", plain, side)).toBe(640);
    }
    expect(await board.best("hard", separate, "full")).toBe(640);
    expect(await board.best("hard", separate, "common")).toBeNull();
    // Счётчики совпадают с настоящими досками; разница досок — ровно аккаунты отдельной доски.
    expect(counts.hard).toEqual({ full: await board.count("hard", "full"), common: await board.count("hard", "common") });
    expect(counts.hard?.full).toBe((counts.hard?.common ?? 0) + 1);
    expect(Object.keys(counts).sort()).toEqual(["easy", "hard", "normal"]);
    expect(await redis.keys("*:rebuild")).toEqual([]);
  });

  it("пересборка по ограничениям спрашивает оба набора: закрытый рейтинг и отдельная доска", async () => {
    const [closed, separate, plain] = [await account(), await account(), await account()];
    for (const id of [closed, separate, plain]) await runs.finish(finished(randomUUID(), id, { difficulty: "hard", survivalSec: 555 }));
    const asked: string[] = [];
    const restrictions = {
      restrictedAccounts: async (kind: string) => {
        asked.push(kind);
        return kind === "leaderboard" ? [closed] : kind === "separate_board" ? [separate] : [];
      },
    };

    await rebuildForRestrictions(runs, board, restrictions, null);

    expect(asked.sort()).toEqual(["leaderboard", "separate_board"]);
    expect(await board.best("hard", closed, "full")).toBeNull();
    expect(await board.best("hard", separate, "full")).toBe(555);
    expect(await board.best("hard", separate, "common")).toBeNull();
    expect(await board.best("hard", plain, "common")).toBe(555);
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
    const details = { ...NO_COUNTERS, passives: [{ id: "might", level: 2 }], damageTaken: 310, xpCollected: 95, waveReached: 4, topKills: [{ enemy: "swarm_rat", count: 200 }] };
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

  it("счётчики итога лежат в run.details ключами, а строка прошлой сборки читается с null (T-0125)", async () => {
    const owner = await account();
    const runId = randomUUID();
    const details = { ...NO_COUNTERS, passives: [], damageTaken: 1, xpCollected: 2, waveReached: 3, topKills: [], bossKills: 1, eliteKills: 4, chestsOpened: 2, crystals: 350, noHitSec: 420, noKillSec: 35, killsByElement: { fire: 12 } };
    await runs.finish(finished(runId, owner, { details }));

    const row = await prisma.run.findUnique({ where: { runId }, select: { details: true } });
    expect(row?.details).toMatchObject({ bossKills: 1, eliteKills: 4, chestsOpened: 2, crystals: 350, noHitSec: 420, noKillSec: 35, killsByElement: { fire: 12 } });
    expect(await runs.detail(owner, runId)).toMatchObject({ details: { bossKills: 1, eliteKills: 4, chestsOpened: 2, crystals: 350, noHitSec: 420, noKillSec: 35, killsByElement: { fire: 12 } } });

    // Запись прошлой сборки: ключей счётчиков в jsonb нет вовсе.
    await prisma.run.update({ where: { runId }, data: { details: { passives: [], damageTaken: 1, xpCollected: 2, waveReached: 3, topKills: [] } } });
    expect(await runs.detail(owner, runId)).toMatchObject({ details: { bossKills: null, eliteKills: null, chestsOpened: null, crystals: null, noHitSec: null, noKillSec: null, killsByElement: null } });
  });

  it("победа над стражем (T-0121): колонки пишутся и читаются, обычный забег — false и null", async () => {
    const owner = await account();
    const [won, plain] = [randomUUID(), randomUUID()];
    await runs.finish(finished(won, owner, { survivalSec: 700, rubezhReached: true, rubezhClearedSec: 650 }));
    await runs.finish(finished(plain, owner));

    expect(await runs.find(won)).toMatchObject({ rubezhReached: true, rubezhClearedSec: 650 });
    expect(await runs.find(plain)).toMatchObject({ rubezhReached: false, rubezhClearedSec: null });
    expect(await prisma.run.findUnique({ where: { runId: won }, select: { rubezhReached: true, rubezhClearedSec: true } })).toEqual({ rubezhReached: true, rubezhClearedSec: 650 });
  });

  it("победители рубежа: рейтинговый забег с вердиктом ok и засчитанной победой; подозрение, нерейтинговый и сложность без доски не считаются", async () => {
    const [winner, suspicious, unranked, reachedOnly, easy] = [await account(), await account(), await account(), await account(), await account()];
    const win = { rubezhReached: true, rubezhClearedSec: 650, survivalSec: 700 };
    await runs.finish(finished(randomUUID(), winner, win));
    await runs.finish(finished(randomUUID(), suspicious, { ...win, verdict: "suspicious", verdictReasons: ["rubezh_implausible"], ranked: false }));
    await runs.finish(finished(randomUUID(), unranked, { ...win, ranked: false }));
    await runs.finish(finished(randomUUID(), reachedOnly, { rubezhReached: true, survivalSec: 700 }));
    await runs.finish(finished(randomUUID(), easy, { ...win, difficulty: "easy" }));

    const winners = await runs.rubezhWinners("hard", null);
    expect(winners).toContain(winner);
    for (const other of [suspicious, unranked, reachedOnly, easy]) expect(winners).not.toContain(other);
    expect(await runs.rubezhWinners("hard", null, [winner, suspicious])).toEqual([winner]);
    expect(await runs.rubezhWinners("easy", null)).toEqual([]);
    expect(await runs.rubezhWinners("hard", null, [])).toEqual([]);
  });

  it("победители рубежа: рейтинговый забег с читами победой не считается, честная победа того же аккаунта — считается", async () => {
    const [cheater, mixed] = [await account(), await account()];
    const win = { rubezhReached: true, rubezhClearedSec: 650, survivalSec: 700 };
    // Читы в рейтинг пускает право владельца и админа (`countInRating`): забег рейтинговый, вердикт ok, победы всё равно нет.
    await runs.finish(finished(randomUUID(), cheater, { ...win, cheats: true }));
    await runs.finish(finished(randomUUID(), mixed, { ...win, cheats: true }));
    await runs.finish(finished(randomUUID(), mixed, { ...win, cheats: false }));

    const winners = await runs.rubezhWinners("hard", null);
    expect(winners).not.toContain(cheater);
    expect(winners).toContain(mixed);
    expect(await runs.rubezhWinners("hard", null, [cheater])).toEqual([]);
    expect(await runs.rubezhWinners("hard", null, [cheater, mixed])).toEqual([mixed]);
  });

  it("отметка в доске: запись вместе с submit, страница читает флаги одним SMISMEMBER", async () => {
    const [winner, plain] = [await account(), await account()];
    await board.submit("hard", winner, 700, ALL_BOARDS, true);
    await board.submit("hard", plain, 650, ALL_BOARDS);
    expect(await redis.sismember("lb:rubezh:hard", winner)).toBe(1);
    expect(await redis.sismember("lb:rubezh:hard", plain)).toBe(0);

    const spy = vi.spyOn(redis, "smismember");
    const top = await board.top("hard", 10_000, "common");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(top.find((entry) => entry.accountId === winner)).toMatchObject({ rubezh: true });
    expect(top.find((entry) => entry.accountId === plain)).not.toHaveProperty("rubezh");
    // Повторная запись без победы набор не сбрасывает: отметка живёт, пока её не снимет пересборка.
    await board.submit("hard", winner, 710, ALL_BOARDS);
    expect(await redis.sismember("lb:rubezh:hard", winner)).toBe(1);
  });

  it("пустая доска: SMISMEMBER не зовётся", async () => {
    const spy = vi.spyOn(redis, "smismember");
    expect(await board.top("easy", 10, "common")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("пересборка восстанавливает набор победителей по базе и убирает лишних", async () => {
    const [winner, plain] = [await account(), await account()];
    await runs.finish(finished(randomUUID(), winner, { survivalSec: 900, rubezhReached: true, rubezhClearedSec: 700 }));
    await runs.finish(finished(randomUUID(), plain, { survivalSec: 800 }));
    await redis.del("lb:rubezh:hard");
    await redis.sadd("lb:rubezh:hard", plain, "призрак");

    await rebuildLeaderboard(runs, board, new Set(), new Set(), null);

    expect(await redis.sismember("lb:rubezh:hard", winner)).toBe(1);
    expect(await redis.sismember("lb:rubezh:hard", plain)).toBe(0);
    expect(await redis.sismember("lb:rubezh:hard", "призрак")).toBe(0);
    expect(await redis.exists("lb:rubezh:hard:rebuild")).toBe(0);
    // Закрытый рейтинг: победитель в доски не попал — и в набор тоже.
    await rebuildLeaderboard(runs, board, new Set([winner]), new Set(), null);
    expect(await redis.sismember("lb:rubezh:hard", winner)).toBe(0);
  });

  it("пересборка не ставит отметку за победу с читами, даже если забег рейтинговый и самый длинный", async () => {
    const cheater = await account();
    await runs.finish(finished(randomUUID(), cheater, { survivalSec: 950, cheats: true, rubezhReached: true, rubezhClearedSec: 700 }));
    await redis.del("lb:rubezh:hard");

    await rebuildLeaderboard(runs, board, new Set(), new Set(), null);

    expect(await redis.sismember("lb:rubezh:hard", cheater)).toBe(0);
  });
});
