import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { BOOSTS, MAX_BOOSTS_PER_RUN } from "../src/content/boosts";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { refreshPlayerStats } from "../src/game/progression/levels";
import { passiveChanges } from "../src/game/progression/upgrade-changes";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { damageEnemy } from "../src/game/sim/combat";
import type { Spawner } from "../src/game/sim/spawner";
import { stepWorld } from "../src/game/sim/step";
import { unlocksAt } from "../src/game/progression/unlocks";
import { createWorld, damagePlayer, DEFAULT_SIM_CONFIG, spawnEnemy, TICK_HZ, type World } from "../src/game/sim/world";

/**
 * Навыки защиты Р157 (T-0286): «Вампиризм» лечит за убийство с потолком в
 * секунду, «Стойкость» раз в N секунд сама ставит щит на одно попадание и
 * складывается со щитами «Эгиды».
 */

const RAT: EnemyDef = { id: "rat", hp: 1, speed: 0.001, damage: 0, xp: 0, pattern: "swarm" };
const NO_SPAWNER: Spawner = { update: () => undefined };

function setup(boosts: string[] = []): World {
  return createWorld({
    seed: 5,
    enemies: [RAT],
    weapons: WEAPONS,
    passives: PASSIVES,
    boosts: BOOSTS,
    maxBoostsPerRun: MAX_BOOSTS_PER_RUN,
    config: { progressionEnabled: false, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 100 } },
    loadout: { modifiers: {}, boosts },
  });
}

function take(world: World, id: string, level: number): void {
  const typeIndex = world.passiveTypes.findIndex((type) => type.id === id);
  expect(typeIndex, `навык ${id} есть в контенте`).toBeGreaterThanOrEqual(0);
  world.loadout.passives.push({ typeIndex, level });
  refreshPlayerStats(world);
}

function kill(world: World, count: number): void {
  for (let i = 0; i < count; i++) {
    const slot = spawnEnemy(world, 0, 300, 0);
    damageEnemy(world, slot, 10, 0);
  }
}

function stepTicks(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, { moveX: 0, moveY: 0 });
}

/** Попадание, которое пробивает неуязвимость после щита: тик между ударами не ждём. */
function hit(world: World, amount = 10): void {
  world.player.invulnerableTicks = 0;
  damagePlayer(world, amount, 0);
}

describe("Вампиризм", () => {
  it("в контенте: защита, здоровье за убийство слагаемым, три уровня 1–2–3", () => {
    const def = PASSIVES.find((passive) => passive.id === "vampirism");
    expect(def).toMatchObject({ category: "defense", stat: "healOnKill", op: "add", levels: [1, 2, 3] });
  });

  it("убийство лечит на значение уровня", () => {
    const world = setup();
    take(world, "vampirism", 2);
    world.player.hp = 50;
    kill(world, 1);
    expect(world.player.hp).toBe(52);
  });

  it("не выше максимума здоровья", () => {
    const world = setup();
    take(world, "vampirism", 3);
    world.player.hp = 99;
    kill(world, 1);
    expect(world.player.hp).toBe(100);
  });

  it("без навыка убийство не лечит", () => {
    const world = setup();
    world.player.hp = 50;
    kill(world, 3);
    expect(world.player.hp).toBe(50);
  });

  it("сто убийств за секунду при 100 здоровья лечат не больше 4", () => {
    const world = setup();
    take(world, "vampirism", 3);
    world.player.hp = 10;
    kill(world, 100);
    expect(world.player.hp).toBeGreaterThan(10);
    expect(world.player.hp - 10).toBeLessThanOrEqual(4 + 1e-9);
  });

  it("потолок — окно в секунду: в следующем окне лечение снова идёт", () => {
    const world = setup();
    take(world, "vampirism", 3);
    world.player.hp = 10;
    kill(world, 100);
    const afterFirst = world.player.hp;
    stepTicks(world, TICK_HZ + 1);
    kill(world, 100);
    expect(world.player.hp - afterFirst).toBeGreaterThan(3);
    expect(world.player.hp - afterFirst).toBeLessThanOrEqual(4 + 1e-9);
  });

  it("потолок считается от максимума: при большем здоровье окно шире — 4% максимума", () => {
    const world = setup();
    take(world, "vitality", 6);
    take(world, "vampirism", 3);
    world.player.hp = 1;
    kill(world, 100);
    const max = world.playerStats.maxHp;
    expect(world.player.hp - 1).toBeLessThanOrEqual(0.04 * max + 1e-9);
    expect(world.player.hp - 1).toBeGreaterThan(0.04 * max - 3);
  });

  it("мёртвого не лечит", () => {
    const world = setup();
    take(world, "vampirism", 3);
    world.player.hp = 0;
    world.player.alive = false;
    kill(world, 1);
    expect(world.player.hp).toBe(0);
  });
});

describe("Стойкость", () => {
  it("в контенте: защита, раз в 30, 25 и 20 секунд", () => {
    const def = PASSIVES.find((passive) => passive.id === "steadfast");
    expect(def).toMatchObject({ category: "defense", stat: "wardIntervalSec", op: "add", levels: [30, 25, 20] });
  });

  it("без навыка щит сам не появляется", () => {
    const world = setup();
    stepTicks(world, 31 * TICK_HZ);
    expect(world.player.shieldHits).toBe(0);
  });

  it("первый уровень: щит через 30 секунд, не раньше", () => {
    const world = setup();
    take(world, "steadfast", 1);
    stepTicks(world, 30 * TICK_HZ - 1);
    expect(world.player.shieldHits).toBe(0);
    stepTicks(world, 1);
    expect(world.player.shieldHits).toBe(1);
  });

  it("при щите таймер стоит, а щит не копится выше одного", () => {
    const world = setup();
    take(world, "steadfast", 1);
    stepTicks(world, 30 * TICK_HZ);
    expect(world.player.shieldHits).toBe(1);
    stepTicks(world, 60 * TICK_HZ);
    expect(world.player.shieldHits).toBe(1);
  });

  it("попадание гасит щит и запускает таймер заново", () => {
    const world = setup();
    take(world, "steadfast", 1);
    stepTicks(world, 30 * TICK_HZ);
    hit(world);
    expect(world.player.shieldHits).toBe(0);
    expect(world.player.hp).toBe(100);
    stepTicks(world, 30 * TICK_HZ - 1);
    expect(world.player.shieldHits).toBe(0);
    stepTicks(world, 1);
    expect(world.player.shieldHits).toBe(1);
  });

  it("высокий уровень ставит щит чаще: 20 секунд", () => {
    const world = setup();
    take(world, "steadfast", 3);
    stepTicks(world, 20 * TICK_HZ);
    expect(world.player.shieldHits).toBe(1);
  });

  it("щит «Эгиды» и щит «Стойкости» складываются, от «Стойкости» — не больше одного", () => {
    const world = setup(["aegis"]);
    expect(world.player.shieldHits).toBe(1);
    take(world, "steadfast", 1);
    stepTicks(world, 90 * TICK_HZ);
    // Один щит буста и один щит оберега, сколько бы ни ждали.
    expect(world.player.shieldHits).toBe(2);

    hit(world);
    hit(world);
    expect(world.player.shieldHits).toBe(0);
    expect(world.player.hp).toBe(100);
    hit(world);
    expect(world.player.hp).toBeLessThan(100);
  });

  it("первым тратится щит буста, а оберег остаётся последним", () => {
    const world = setup(["aegis"]);
    take(world, "steadfast", 1);
    stepTicks(world, 30 * TICK_HZ);
    expect(world.player.shieldHits).toBe(2);
    hit(world);
    expect(world.player.shieldHits).toBe(1);
    // Таймер стоит, пока цел щит оберега: через время щитов всё равно один.
    stepTicks(world, 60 * TICK_HZ);
    expect(world.player.shieldHits).toBe(1);
    hit(world);
    expect(world.player.shieldHits).toBe(0);
  });

  it("снимок с таймером: после восстановления щит приходит в ту же секунду", () => {
    const original = setup();
    take(original, "steadfast", 1);
    stepTicks(original, 29 * TICK_HZ);
    expect(original.player.shieldHits).toBe(0);

    const saved: unknown = JSON.parse(JSON.stringify(captureWorld(original, NO_SPAWNER)));
    const resumed = setup();
    take(resumed, "steadfast", 1);
    restoreWorld(resumed, NO_SPAWNER, saved);

    stepTicks(resumed, TICK_HZ - 1);
    expect(resumed.player.shieldHits).toBe(0);
    stepTicks(resumed, 1);
    expect(resumed.player.shieldHits).toBe(1);

    stepTicks(original, TICK_HZ);
    expect(original.player.shieldHits).toBe(1);
  });

  it("снимок с щитом оберега: следующее попадание его гасит, таймер идёт заново", () => {
    const original = setup();
    take(original, "steadfast", 1);
    stepTicks(original, 30 * TICK_HZ);
    const saved: unknown = JSON.parse(JSON.stringify(captureWorld(original, NO_SPAWNER)));
    const resumed = setup();
    take(resumed, "steadfast", 1);
    restoreWorld(resumed, NO_SPAWNER, saved);

    expect(resumed.player.shieldHits).toBe(1);
    hit(resumed);
    expect(resumed.player.shieldHits).toBe(0);
    stepTicks(resumed, 30 * TICK_HZ);
    expect(resumed.player.shieldHits).toBe(1);
  });
});

describe("карточка и открытие", () => {
  const type = (id: string) => {
    const world = setup();
    const found = world.passiveTypes.find((passive) => passive.id === id);
    expect(found, id).toBeDefined();
    return found!;
  };

  it("Вампиризм показывает «лечение за убийство 1 → 2»", () => {
    expect(passiveChanges(type("vampirism"), 1, 2)).toEqual([
      { labelKey: "upgrade.stat.passive.healOnKill", from: 1, to: 2, format: "value", lowerIsBetter: false },
    ]);
  });

  it("Стойкость показывает «щит раз в 30 с → 25 с»: меньше — лучше", () => {
    expect(passiveChanges(type("steadfast"), 1, 2)).toEqual([
      { labelKey: "upgrade.stat.passive.wardIntervalSec", from: 30, to: 25, format: "value", lowerIsBetter: true },
    ]);
    expect(passiveChanges(type("steadfast"), null, 1)[0]).toMatchObject({ from: null, to: 30 });
  });

  it("открываются на 17-м и 19-м уровнях", () => {
    const at = (level: number) => unlocksAt(ACCOUNT_UNLOCKS, level).passives;
    expect(at(16).has("vampirism")).toBe(false);
    expect(at(17).has("vampirism")).toBe(true);
    expect(at(18).has("steadfast")).toBe(false);
    expect(at(19).has("steadfast")).toBe(true);
  });

  it("открытых навыков защиты на каждом уровне больше слотов защиты", () => {
    const defense = new Set(PASSIVES.filter((passive) => passive.category === "defense").map((passive) => passive.id));
    const last = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));
    for (let level = 1; level <= last; level++) {
      const open = unlocksAt(ACCOUNT_UNLOCKS, level);
      const count = [...open.passives].filter((id) => defense.has(id)).length;
      expect(count, `уровень ${String(level)}`).toBeGreaterThan(open.limits.passives.defense);
    }
    expect(LOADOUT_LIMITS.passives.defense).toBeLessThan(defense.size);
  });
});
