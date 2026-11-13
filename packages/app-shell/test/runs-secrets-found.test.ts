import { describe, expect, it } from "vitest";
import type { RunResult } from "@bh/shared-types";
import { toSubmission } from "../src/state/runs";

// Найденные виды тайников в отправке итога (tasks/T-0261): по ним сервер открывает кодекс тайников.

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

describe("отправка итога: secretsFound", () => {
  it("найденные виды уходят в stats как есть", () => {
    const stats = toSubmission(result({ secrets: { found: ["shrine", "hoard"], used: ["shrine"] } })).stats;

    expect(stats?.secretsFound).toEqual(["shrine", "hoard"]);
  });

  it("итог без поля (прошлый движок) уходит без ключа", () => {
    expect(toSubmission(result()).stats).not.toHaveProperty("secretsFound");
  });

  it("ничего не найдено — пустой список: тайников не было, и это не «неизвестно»", () => {
    expect(toSubmission(result({ secrets: { found: [], used: [] } })).stats?.secretsFound).toEqual([]);
  });

  it("длиннее потолка сервера обрезается до двенадцати: иначе итог целиком уйдёт в отказ формы", () => {
    const kinds = Array.from({ length: 15 }, () => "shrine" as const);

    expect(toSubmission(result({ secrets: { found: kinds, used: [] } })).stats?.secretsFound).toHaveLength(12);
  });
});
