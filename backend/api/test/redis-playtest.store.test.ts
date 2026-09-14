import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config";
import type { StoredRun } from "../src/modules/playtest/playtest.store";
import { RedisPlaytestStore } from "../src/modules/playtest/redis-playtest.store";

// Хранилище плейтеста на живом Redis. Сценарий тот же, что у хранилища в
// памяти, но проверяется то, что память не покажет: Lua-скрипт лучшего
// времени, повтор по `runId`, порядок и детали лидерборда.
//
// Идёт только с PLAYTEST_TEST_REDIS_URL — отдельной базой Redis, которую
// тест очищает целиком: `redis://localhost:6379/15`. В CI Redis пока нет,
// и там тест пропускается (docs/17-testing-strategy.md §4.2).
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

describe.skipIf(url === "")("хранилище плейтеста на Redis", () => {
  let store: RedisPlaytestStore;
  let admin: Redis;

  beforeAll(async () => {
    admin = new Redis(url);
    await admin.flushdb();
    store = new RedisPlaytestStore(loadAppConfig({ REDIS_URL: url, PLAYTEST_DATA_TTL_DAYS: "1" }));
  });

  afterAll(async () => {
    await admin.flushdb();
    await admin.quit();
    await store.onModuleDestroy();
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

  it("ставит срок жизни на ключи: данные плейтеста исчезают сами", async () => {
    for (const key of ["pt:lb:normal", "pt:lbrun:normal", "pt:player:10", "pt:stats:10", "pt:runs:10", "pt:run:r-1"]) {
      const ttl = await admin.ttl(key);
      expect(ttl, key).toBeGreaterThan(0);
      expect(ttl, key).toBeLessThanOrEqual(86_400);
    }
  });
});
