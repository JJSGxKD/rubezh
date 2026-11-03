import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { MAX_HUNT_ENTRIES } from "../src/game/run/hunt-log";
import { addPassive, addWeapon } from "../src/game/progression/loadout";
import { buildRunResult } from "../src/game/run/run-result";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { killEnemy } from "../src/game/sim/combat";
import { createConstantPopulationSpawner } from "../src/game/sim/spawner";
import { createWorld, spawnEnemy, TICK_HZ, type World } from "../src/game/sim/world";

// Журнал охоты и оценка сборки в итоге забега (tasks/T-0292). Только считают:
// ни world.rng, ни порядок событий не трогают.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const ELITE: EnemyDef = { id: "elite", hp: 100, speed: 0.001, damage: 0, xp: 7, pattern: "swarm", rank: "elite" };
const BOSS: EnemyDef = { id: "boss", hp: 100, speed: 0.001, damage: 0, xp: 40, pattern: "swarm", rank: "boss" };
const FIXTURE = [GRUNT, ELITE, BOSS];
const [GRUNT_TYPE, ELITE_TYPE, BOSS_TYPE] = [0, 1, 2];

function fixtureWorld(): World {
  return createWorld({
    seed: 1,
    enemies: FIXTURE,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: CHESTS,
  });
}

function result(world: World) {
  return buildRunResult(world, { runId: "r", seed: 1, outcome: "died", startingWeaponId: "spark", contentHash: "h" });
}

describe("журнал охоты", () => {
  it("элита убита через 12,4 с после появления — строка с value из xp и aliveSec", () => {
    const world = fixtureWorld();
    const slot = spawnEnemy(world, ELITE_TYPE, 100, 0);
    world.stats.tick += Math.round(12.4 * TICK_HZ);
    killEnemy(world, slot);

    const log = result(world).huntLog;
    expect(log).toHaveLength(1);
    expect(log?.[0]?.rank).toBe("elite");
    expect(log?.[0]?.value).toBe(7);
    expect(log?.[0]?.aliveSec).toBeCloseTo(12.4, 1);
  });

  it("босс пишется с рангом boss", () => {
    const world = fixtureWorld();
    const slot = spawnEnemy(world, BOSS_TYPE, 100, 0);
    world.stats.tick += 5 * TICK_HZ;
    killEnemy(world, slot);

    expect(result(world).huntLog).toEqual([{ rank: "boss", value: 40, aliveSec: 5 }]);
  });

  it("не убитая элита и рядовой враг без строки", () => {
    const world = fixtureWorld();
    spawnEnemy(world, ELITE_TYPE, 100, 0);
    killEnemy(world, spawnEnemy(world, GRUNT_TYPE, 120, 0));

    expect(result(world).huntLog).toEqual([]);
  });

  it("слот переиспользован: время считается от нового появления", () => {
    const world = fixtureWorld();
    killEnemy(world, spawnEnemy(world, GRUNT_TYPE, 100, 0));
    world.stats.tick += 100 * TICK_HZ;
    const slot = spawnEnemy(world, ELITE_TYPE, 100, 0);
    world.stats.tick += 2 * TICK_HZ;
    killEnemy(world, slot);

    expect(result(world).huntLog?.[0]?.aliveSec).toBe(2);
  });

  it("65-я убитая элита не пишется", () => {
    const world = fixtureWorld();
    for (let i = 0; i < MAX_HUNT_ENTRIES + 1; i++) killEnemy(world, spawnEnemy(world, ELITE_TYPE, 100, 0));

    expect(MAX_HUNT_ENTRIES).toBe(64);
    expect(result(world).huntLog).toHaveLength(64);
    expect(world.stats.eliteKills).toBe(65);
  });

  it("снимок с живой элитой и записью: после восстановления то же aliveSec", () => {
    const world = fixtureWorld();
    const spawner = createConstantPopulationSpawner(0);
    killEnemy(world, spawnEnemy(world, BOSS_TYPE, 100, 0));
    const slot = spawnEnemy(world, ELITE_TYPE, 100, 0);
    world.stats.tick += 3 * TICK_HZ;

    const saved = JSON.parse(JSON.stringify(captureWorld(world, spawner))) as unknown;
    const restored = fixtureWorld();
    restoreWorld(restored, spawner, saved);
    restored.stats.tick += 4 * TICK_HZ;
    killEnemy(restored, slot);

    expect(result(restored).huntLog).toEqual([
      { rank: "boss", value: 40, aliveSec: 0 },
      { rank: "elite", value: 7, aliveSec: 7 },
    ]);
  });
});

describe("оценка сборки", () => {
  function weaponIndex(world: World, id: string): number {
    const index = world.weaponTypes.findIndex((type) => type.id === id);
    if (index < 0) throw new Error(`нет оружия ${id}`);
    return index;
  }

  it("пустой набор — ноль", () => {
    const world = fixtureWorld();
    world.loadout.weapons.length = 0;
    world.loadout.passives.length = 0;
    expect(result(world).buildScore).toBe(0);
  });

  it("1 эволюция, 2 оружия и 1 навык на максимуме — 5", () => {
    const world = fixtureWorld();
    world.loadout.weapons.length = 0;
    world.loadout.passives.length = 0;
    // Эволюция — одноуровневое оружие: она и эволюция, и оружие на максимуме.
    addWeapon(world.loadout, weaponIndex(world, "starfall"));
    const knife = addWeapon(world.loadout, weaponIndex(world, "knife"));
    knife.level = world.weaponTypes[knife.typeIndex]?.levels.length ?? 1;
    // Оружие не на максимуме в счёт не идёт.
    addWeapon(world.loadout, weaponIndex(world, "storm"));
    const passive = addPassive(world.loadout, 0);
    passive.level = world.passiveTypes[0]?.levels.length ?? 1;
    // Навык не на максимуме — тоже.
    expect(world.passiveTypes[1]?.levels.length ?? 1).toBeGreaterThan(1);
    addPassive(world.loadout, 1).level = 1;

    expect(result(world).buildScore).toBe(5);
  });
});
