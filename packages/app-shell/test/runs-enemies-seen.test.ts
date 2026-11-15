import { describe, expect, it } from "vitest";
import type { RunResult } from "@bh/shared-types";
import { toSubmission } from "../src/state/runs";

// Встреченные враги в отправке итога (tasks/T-0479): по ним сервер открывает записи кодекса.

function result(patch: Partial<RunResult> = {}): RunResult {
  return {
    runId: "run-00000001",
    seed: 7,
    outcome: "died",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "hard",
    contentHash: "abcd1234",
    waveReached: 3,
    survivalSec: 184.5,
    level: 9,
    xpCollected: 300,
    enemiesKilled: 212,
    killsByEnemy: { swarm_rat: 200 },
    damageDealt: 5000,
    damageTaken: 120,
    damageByElement: {},
    noHitSec: 0,
    noKillSec: 0,
    killsByElement: {},
    bossKills: 0,
    eliteKills: 0,
    chestsOpened: 0,
    rareChestsOpened: 0,
    crystalsCollected: 0,
    weapons: [{ id: "spark", level: 4, damage: 4000 }],
    passives: [{ id: "might", level: 2 }],
    deathCause: "swarm_rat",
    distance: 9000,
    peakEnemies: 80,
    cheats: false,
    continues: [],
    ...patch,
  };
}

describe("отправка итога: enemiesSeen", () => {
  it("список встреченных уходит в stats как есть, включая неубитых босса и элиту", () => {
    const stats = toSubmission(result({ enemiesSeen: ["swarm_rat", "elite_ghoul", "boss_ram"] })).stats;

    expect(stats?.enemiesSeen).toEqual(["swarm_rat", "elite_ghoul", "boss_ram"]);
  });

  it("итог без поля (прошлый движок) уходит без ключа", () => {
    expect(toSubmission(result()).stats).not.toHaveProperty("enemiesSeen");
  });

  it("пустой список уходит пустым: врагов не было, и это не «неизвестно»", () => {
    expect(toSubmission(result({ enemiesSeen: [] })).stats?.enemiesSeen).toEqual([]);
  });

  it("длиннее потолка сервера обрезается до 64: иначе итог целиком уйдёт в отказ формы", () => {
    const ids = Array.from({ length: 70 }, (_, index) => `enemy_${index}`);

    expect(toSubmission(result({ enemiesSeen: ids })).stats?.enemiesSeen).toEqual(ids.slice(0, 64));
  });
});
