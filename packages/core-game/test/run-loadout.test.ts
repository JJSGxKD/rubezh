import type { EnemyDef, RunLoadout } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { PASSIVES } from "../src/content/upgrades";
import { replayRecording } from "../src/game/diagnostics/replay";
import { refreshPlayerStats } from "../src/game/progression/levels";
import { LOADOUT_BOUNDS, sanitizeLoadout } from "../src/game/progression/run-loadout";
import { damageEnemy } from "../src/game/sim/combat";
import { ELEMENT_FIRE, ELEMENT_PHYSICAL } from "../src/game/sim/elements";
import { createWorld, DEFAULT_SIM_CONFIG, spawnEnemy, type World } from "../src/game/sim/world";
import { circling, recordHeadlessRun } from "./helpers/recorded-run";

/**
 * Набор на забег — модификаторы снаряжения, дерева и бустов
 * (docs/35-stage4-plan.md §3.3, WP7). Проверяется граница: движок принимает
 * готовые числа, складывает их с базой до пассивок, не даёт битому набору
 * сломать забег и пишет набор в запись — иначе повтор снаряжённого забега
 * разошёлся бы с оригиналом.
 */

const DUMMY: EnemyDef = { id: "dummy", hp: 10_000, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };

function withLoadout(loadout?: RunLoadout): World {
  return createWorld({
    seed: 1,
    enemies: [DUMMY],
    weapons: [],
    passives: PASSIVES,
    config: { player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 100 } },
    ...(loadout === undefined ? {} : { loadout }),
  });
}

describe("разбор набора", () => {
  it("отбрасывает неизвестное, нечисловое и отрицательное, срезает слишком большое", () => {
    const loadout = sanitizeLoadout({
      modifiers: { damage: 0.2, maxHp: Number.NaN, armor: -2, luck: 5, cooldown: 99 },
      boosts: ["magnet_start", 7, "", "x".repeat(100)],
    });
    expect(loadout).toEqual({ modifiers: { damage: 0.2, cooldown: LOADOUT_BOUNDS.cooldown }, boosts: ["magnet_start"] });
  });

  it("не набор — пустой набор, а не падение", () => {
    expect(sanitizeLoadout(null)).toEqual({ modifiers: {}, boosts: [] });
    expect(sanitizeLoadout("damage")).toEqual({ modifiers: {}, boosts: [] });
    expect(sanitizeLoadout({ modifiers: 3, boosts: "x" })).toEqual({ modifiers: {}, boosts: [] });
  });
});

describe("набор в характеристиках", () => {
  it("складывается с базой: множители — прибавкой, здоровье и броня — числом", () => {
    const plain = withLoadout();
    const geared = withLoadout({
      modifiers: { damage: 0.12, cooldown: 0.05, maxHp: 20, armor: 1, pickupRadius: 0.1, resistFire: 0.2, moveSpeed: 0.04 },
      boosts: [],
    });
    const stats = geared.playerStats;
    expect(stats.damageMul).toBeCloseTo(1.12, 9);
    expect(stats.cooldownMul).toBeCloseTo(0.95, 9);
    expect(stats.maxHp).toBe(120);
    expect(stats.armor).toBe(1);
    expect(stats.resistFire).toBe(0.2);
    expect(stats.moveSpeedMul).toBeCloseTo(1.04, 9);
    expect(stats.pickupRadius).toBeCloseTo(plain.playerStats.pickupRadius * 1.1, 9);
    // Игрок начинает полным — со здоровьем снаряжения.
    expect(geared.player.hp).toBe(120);
    expect(geared.player.maxHp).toBe(120);
  });

  it("пассивки забега ложатся поверх снаряжения, а не затирают его", () => {
    const world = withLoadout({ modifiers: { damage: 0.1, maxHp: 30 }, boosts: [] });
    for (const id of ["might", "vitality"]) {
      world.loadout.passives.push({ typeIndex: world.passiveTypes.findIndex((type) => type.id === id), level: 1 });
    }
    refreshPlayerStats(world);
    const might = PASSIVES.find((passive) => passive.id === "might")?.levels[0] ?? 1;
    const vitality = PASSIVES.find((passive) => passive.id === "vitality")?.levels[0] ?? 0;
    expect(world.playerStats.damageMul).toBeCloseTo(1.1 * might, 9);
    expect(world.playerStats.maxHp).toBe(100 + 30 + vitality);
  });

  it("урон стихии усиливает только оружие этой стихии", () => {
    const world = withLoadout({ modifiers: { damageFire: 0.5 }, boosts: [] });
    const fire = spawnEnemy(world, 0, 300, 0);
    const plain = spawnEnemy(world, 0, -300, 0);
    damageEnemy(world, fire, 100, 0, ELEMENT_FIRE);
    damageEnemy(world, plain, 100, 0, ELEMENT_PHYSICAL);
    expect(10_000 - world.enemies.hp[fire]).toBeCloseTo(150, 5);
    expect(10_000 - world.enemies.hp[plain]).toBeCloseTo(100, 5);
  });

  it("шанс состояния растёт до единицы — и тогда генератор не трогается", () => {
    const world = withLoadout({ modifiers: { statusChance: 1 }, boosts: [] });
    const enemy = spawnEnemy(world, 0, 300, 0);
    const rng = world.rng.getState();
    damageEnemy(world, enemy, 10, 0, ELEMENT_FIRE, 0.5);
    expect(world.enemies.burnTimer[enemy]).toBeGreaterThan(0);
    expect(world.rng.getState()).toBe(rng);
  });
});

describe("набор в записи забега", () => {
  const loadout: RunLoadout = { modifiers: { damage: 0.3, maxHp: 40, damageLightning: 0.2 }, boosts: ["magnet_start"] };

  it("пишется в запись, и повтор со снаряжением совпадает", () => {
    const recording = recordHeadlessRun({ seed: 1235, maxTicks: 3_000, steer: circling(150), loadout });
    expect(recording.loadout).toEqual(loadout);
    expect(replayRecording(recording).verdict).toBe("match");
  });

  it("без набора повтор того же забега расходится — набор действительно участвует", () => {
    const recording = recordHeadlessRun({ seed: 1235, maxTicks: 3_000, steer: circling(150), loadout });
    const stripped = { ...recording };
    delete stripped.loadout;
    expect(replayRecording(stripped).verdict).toBe("mismatch");
  });

  it("забег без снаряжения поля в записи не несёт", () => {
    const recording = recordHeadlessRun({ seed: 1235, maxTicks: 600, steer: circling(150) });
    expect("loadout" in recording).toBe(false);
  });
});
