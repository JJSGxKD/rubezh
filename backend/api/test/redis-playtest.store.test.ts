import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { RedisBotPollerLocks } from "../src/modules/bot/bot-poller.js";
import { RedisStatsReporterLocks } from "../src/modules/playtest/playtest-stats.reporter.js";
import type { StressSummary } from "../src/modules/playtest/playtest-stats.store.js";
import type { StoredRun } from "../src/modules/playtest/playtest.store.js";
import { RedisPlaytestStatsStore } from "../src/modules/playtest/redis-playtest-stats.store.js";
import { RedisPlaytestStore } from "../src/modules/playtest/redis-playtest.store.js";

// Хранилище плейтеста на живом Redis. Сценарий тот же, что у хранилища в
// памяти, но проверяется то, что память не покажет: Lua-скрипт лучшего
// времени, повтор по `runId`, порядок и детали лидерборда.
//
// Идёт только с PLAYTEST_TEST_REDIS_URL — отдельной базой Redis, которую
// тест очищает целиком: `redis://localhost:6379/15`. В CI Redis пока не
// поднят, и там тест пропускается; настоящий Redis в CI по
// docs/17-testing-strategy.md §4.2 появится вместе с Testcontainers.
const url = process.env.PLAYTEST_TEST_REDIS_URL ?? "";

function run(runId: string, survivalSec: number, patch: Partial<StoredRun> = {}): StoredRun {
  return {
    runId,
    difficultyId: "normal",
    outcome: "died",
    survivalSec,
    level: 5,
    enemiesKilled: 50,
    startingWeaponId: "knife",
    weapons: [{ id: "knife", level: 2 }],
    contentHash: "abc",
    at: 1,
    ...patch,
  };
}

function stressSummary(reportId: string): StressSummary {
  return {
    reportId,
    build: "0.3.0",
    mode: "stress",
    loadout: "full",
    outcome: "degradation",
    device: {
      clientPlatform: "android",
      clientVersion: "8.0",
      os: "android",
      formFactor: "phone",
      screenWidth: 412,
      screenHeight: 915,
      pixelRatio: 2.63,
      cores: 8,
      memoryGb: 8,
    },
    peakObjects: 900,
    peakEnemies: 700,
    peakProjectiles: 200,
    avgFps: 58,
    p95FrameMs: 21,
    displayHz: 60,
    durationSec: 94,
    interruptions: 0,
    breakingLoad: 640,
  };
}

describe.skipIf(url === "")("хранилище плейтеста на Redis", () => {
  let store: RedisPlaytestStore;
  let stats: RedisPlaytestStatsStore;
  let redis: Redis;
  let admin: Redis;

  beforeAll(async () => {
    admin = new Redis(url);
    await admin.flushdb();
    const config = loadAppConfig({ REDIS_URL: url, PLAYTEST_DATA_TTL_DAYS: "1" });
    redis = createRedis(config);
    store = new RedisPlaytestStore(redis, config);
    stats = new RedisPlaytestStatsStore(redis, config);
  });

  afterAll(async () => {
    await admin.flushdb();
    await admin.quit();
    await closeRedis(redis);
  });

  it("обновляет лучшее время только улучшением, вместе с деталями забега", async () => {
    await store.savePlayer({ id: "10", name: "Анна", username: null, photoUrl: null });
    expect(await store.recordRun("10", run("r-1", 120, { level: 9 }))).toEqual({
      duplicate: false,
      isNewBest: true,
      bestSurvivalSec: 120,
    });
    expect(await store.recordRun("10", run("r-2", 80, { level: 3 }))).toEqual({
      duplicate: false,
      isNewBest: false,
      bestSurvivalSec: 120,
    });

    const [row] = await store.leaderboard("normal", 10);
    expect(row).toMatchObject({ playerId: "10", name: "Анна", survivalSec: 120, level: 9, photoUrl: null });
  });

  it("повтор того же забега не удваивает статистику", async () => {
    expect(await store.recordRun("10", run("r-2", 80))).toMatchObject({ duplicate: true, bestSurvivalSec: 120 });
    expect(await store.stats("10")).toEqual({ runs: 2, totalKills: 100, totalSurvivalSec: 200 });
    expect((await store.recentRuns("10", 5)).map((entry) => entry.runId)).toEqual(["r-2", "r-1"]);
  });

  it("сортирует лидерборд по убыванию времени и считает места", async () => {
    await store.savePlayer({ id: "20", name: "Борис", username: null, photoUrl: "https://t.me/i/b.jpg" });
    await store.recordRun("20", run("r-3", 300));

    const rows = await store.leaderboard("normal", 10);
    expect(rows.map((entry) => entry.playerId)).toEqual(["20", "10"]);
    expect(rows[0]?.photoUrl).toBe("https://t.me/i/b.jpg");
    expect(await store.rank("normal", "10")).toBe(2);
    expect(await store.playerCount("normal")).toBe(2);
    expect(await store.rank("hard", "10")).toBeNull();
  });

  it("собирает сводку: игроки за всё время и за сутки, устройства, забеги по сложностям", async () => {
    const now = Date.parse("2026-09-14T12:00:00Z");
    const device = {
      clientPlatform: "android",
      clientVersion: "8.0",
      os: "android" as const,
      formFactor: "phone" as const,
      screenWidth: 412,
      screenHeight: 915,
      pixelRatio: 2.63,
      cores: 8,
      memoryGb: 8,
    };
    await stats.recordSession("10", { installId: "install-a", build: "0.3.0", contentHash: "abc", device }, now);
    await stats.recordSession("20", { installId: "install-b", build: "0.3.0", contentHash: "abc", device: { ...device, os: "ios", clientPlatform: "ios" } }, now);
    // Вчерашний запуск: в «сегодня» не попадает, в «всего» — да.
    await stats.recordSession("30", { installId: "install-c", build: "0.3.0", contentHash: "abc", device: { ...device, formFactor: "tablet" } }, now - 86_400_000);
    await stats.recordRun("10", run("s-1", 150, { deathCause: "swarm_rat" }), now);
    await stats.recordRun("10", run("s-2", 30, { outcome: "abandoned", deathCause: null }), now);
    await stats.recordRun("20", run("s-3", 700, { difficultyId: "hard", startingWeaponId: "spark" }), now);
    await admin.set("pt:st:install:broken", "{not json");
    await admin.sadd("pt:st:installs", "broken");

    const snapshot = await stats.snapshot(now);
    expect(snapshot).toMatchObject({
      playersSeen: 3,
      playersPlayed: 2,
      playersSeenToday: 2,
      playersPlayedToday: 2,
      runsToday: 3,
      installs: 3,
    });
    expect(snapshot.byOs).toEqual({ android: 2, ios: 1 });
    expect(snapshot.byFormFactor).toEqual({ phone: 2, tablet: 1 });
    expect(snapshot.difficulties.normal).toMatchObject({ runs: 2, totalSurvivalSec: 180, totalLevel: 10, abandoned: 1 });
    expect(snapshot.difficulties.normal.buckets.slice(0, 3)).toEqual([1, 1, 0]);
    // 700 с — почти двенадцать минут: корзина «от 10 до 15».
    expect(snapshot.difficulties.hard.buckets[4]).toBe(1);
    expect(snapshot.startingWeapons).toEqual({ knife: 2, spark: 1 });
    expect(snapshot.deathCauses).toEqual({ swarm_rat: 1 });
  });

  it("не считает повтор отчёта стресс-теста", async () => {
    const summary = stressSummary("stress-1");
    expect(await stats.recordStress(summary, 1)).toBe(true);
    expect(await stats.recordStress(summary, 1)).toBe(false);
    expect((await stats.snapshot(1)).stress).toEqual({
      reports: 1,
      byOs: { android: { reports: 1, totalPeak: 900, outcomes: { degradation: 1 } } },
    });
    const recent = await admin.lrange("pt:st:stress:recent", 0, -1);
    expect(recent).toHaveLength(1);
    expect(JSON.parse(recent[0] ?? "{}")).toMatchObject({ reportId: "stress-1", peakObjects: 900, at: 1 });
  });

  it("держит одного читателя обновлений бота, а сводку — одну на сутки и на окно команды", async () => {
    const locks = new RedisBotPollerLocks(redis);
    expect(await locks.holdPoller("a", 60_000)).toBe(true);
    expect(await locks.holdPoller("b", 60_000)).toBe(false);
    // Продление своим владельцем — не захват заново.
    expect(await locks.holdPoller("a", 60_000)).toBe(true);
    await locks.releasePoller("b");
    expect(await locks.holdPoller("b", 60_000)).toBe(false);
    await locks.releasePoller("a");
    expect(await locks.holdPoller("b", 60_000)).toBe(true);

    expect(await locks.readOffset()).toBeNull();
    await locks.saveOffset(42);
    expect(await locks.readOffset()).toBe(42);

    const reporter = new RedisStatsReporterLocks(redis);
    expect(await reporter.claimDaily("2026-09-14")).toBe(true);
    expect(await reporter.claimDaily("2026-09-14")).toBe(false);
    await reporter.releaseDaily("2026-09-14");
    expect(await reporter.claimDaily("2026-09-14")).toBe(true);
    expect(await reporter.claimCommand("-100", 20)).toBe(true);
    expect(await reporter.claimCommand("-100", 20)).toBe(false);
  });

  it("ставит срок жизни на ключи: данные плейтеста исчезают сами", async () => {
    for (const key of [
      "pt:lb:normal",
      "pt:lbrun:normal",
      "pt:player:10",
      "pt:stats:10",
      "pt:runs:10",
      "pt:run:r-1",
      "pt:st:seen",
      "pt:st:played",
      "pt:st:installs",
      "pt:st:install:install-a",
      "pt:st:diff:normal",
      "pt:st:weapon",
      "pt:st:stress",
      "pt:st:stress:recent",
    ]) {
      const ttl = await admin.ttl(key);
      expect(ttl, key).toBeGreaterThan(0);
      expect(ttl, key).toBeLessThanOrEqual(86_400);
    }
  });
});
