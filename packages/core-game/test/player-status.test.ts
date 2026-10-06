import type { EnemyDef, PassiveDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { findEnemyContentProblems } from "../src/game/patterns/enemy-types";
import { computePlayerStats, findPassiveContentProblems, resolvePassiveTypes } from "../src/game/progression/passives";
import { applyContinue } from "../src/game/sim/continue";
import {
  MAX_PLAYER_RESIST,
  PLAYER_BURN_DPS_SHARE,
  PLAYER_BURN_SEC,
  PLAYER_CHILL_SLOW,
  PLAYER_POISON_MAX_STACKS,
  PLAYER_SHOCK_BONUS,
} from "../src/game/sim/player-status";
import { stepWorld } from "../src/game/sim/step";
import { createWorld, damagePlayer, DEFAULT_SIM_CONFIG, TICK_SEC, type World } from "../src/game/sim/world";

/**
 * Состояния на игроке от стихийных атак врагов (docs/35-stage4-plan.md,
 * §3.3, WP6). Проверяется то, что ломается незаметно: урон по времени мимо
 * брони и неуязвимости, сопротивление, которое гасит и длительность, второй
 * шанс, возвращающий горящего игрока, и причина смерти от горения.
 */

const PLAIN: EnemyDef = { id: "plain", hp: 10, speed: 1, damage: 10, xp: 1, pattern: "swarm" };
const EMBER: EnemyDef = { ...PLAIN, id: "ember", element: "fire" };
const FROST: EnemyDef = { ...PLAIN, id: "frost", element: "cold" };
const SPARK: EnemyDef = { ...PLAIN, id: "spark", element: "lightning" };
const VENOM: EnemyDef = { ...PLAIN, id: "venom", element: "poison" };
const RARE: EnemyDef = { ...PLAIN, id: "rare", element: "fire", statusChance: 0 };

const TYPES = [PLAIN, EMBER, FROST, SPARK, VENOM, RARE];
const type = (id: string): number => TYPES.findIndex((def) => def.id === id);

const TEMPERING: PassiveDef = { id: "tempering", nameKey: "n", descriptionKey: "d", category: "defense", stat: "resist", op: "add", levels: [0.5, 0.9] };

function setup(): World {
  return createWorld({
    seed: 3,
    enemies: TYPES,
    weapons: [],
    passives: [TEMPERING],
    continueRules: { perRun: 1, restoreHpRatio: 0.5, invulnerableSec: 2 },
    config: { progressionEnabled: false, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1000 } },
  });
}

function stepSeconds(world: World, seconds: number): void {
  for (let tick = 0; tick < Math.round(seconds / TICK_SEC); tick++) stepWorld(world, { moveX: 0, moveY: 0 });
}

function resistAll(world: World, value: number): void {
  world.playerStats.resistFire = value;
  world.playerStats.resistCold = value;
  world.playerStats.resistLightning = value;
  world.playerStats.resistPoison = value;
}

describe("состояния на игроке", () => {
  it("огненное касание поджигает: горит по времени, мимо брони, и перестаёт", () => {
    const world = setup();
    world.playerStats.armor = 5;
    damagePlayer(world, 10, type("ember"));
    const afterHit = world.player.hp;
    expect(world.player.burnTimer).toBe(PLAYER_BURN_SEC);

    stepSeconds(world, PLAYER_BURN_SEC + 1);
    // Урон попадания после брони — 5, горение — доля от него в секунду.
    expect(afterHit - world.player.hp).toBeCloseTo(5 * PLAYER_BURN_DPS_SHARE * PLAYER_BURN_SEC, 5);
    expect(world.player.burnTimer).toBe(0);
  });

  it("физическая атака состояний не накладывает, шанс ноль — тоже", () => {
    const world = setup();
    damagePlayer(world, 10, type("plain"));
    damagePlayer(world, 10, type("rare"));
    expect(world.player.burnTimer).toBe(0);
  });

  it("умерший от горения погиб от того, кто поджёг", () => {
    const world = setup();
    damagePlayer(world, 10, type("ember"));
    world.player.hp = 0.01;
    stepSeconds(world, 0.5);
    expect(world.player.alive).toBe(false);
    expect(world.stats.deathCauseType).toBe(type("ember"));
  });

  it("охлаждённый бежит медленнее и без заморозки", () => {
    const run = (chilled: boolean): number => {
      const world = setup();
      for (let hit = 0; hit < 10 && chilled; hit++) damagePlayer(world, 1, type("frost"));
      for (let tick = 0; tick < 30; tick++) stepWorld(world, { moveX: 1, moveY: 0 });
      return world.player.x;
    };
    const free = run(false);
    const chilled = run(true);
    expect(chilled).toBeGreaterThan(0);
    expect(chilled).toBeLessThan(free);
    expect(chilled / free).toBeGreaterThan(1 - PLAYER_CHILL_SLOW - 0.1);
  });

  it("шокированный получает больше урона от всего", () => {
    const world = setup();
    damagePlayer(world, 1, type("spark"));
    const hp = world.player.hp;
    damagePlayer(world, 100, type("plain"));
    expect(hp - world.player.hp).toBeCloseTo(100 * (1 + PLAYER_SHOCK_BONUS), 5);
  });

  it("яд складывается слоями до потолка", () => {
    const world = setup();
    for (let hit = 0; hit < PLAYER_POISON_MAX_STACKS + 3; hit++) damagePlayer(world, 10, type("venom"));
    expect(world.player.poisonStacks).toBe(PLAYER_POISON_MAX_STACKS);
  });

  it("неуязвимость глушит урон по времени, второй шанс снимает состояния", () => {
    const world = setup();
    damagePlayer(world, 10, type("ember"));
    damagePlayer(world, 10, type("venom"));
    damagePlayer(world, world.player.hp + 100, type("plain"));
    expect(applyContinue(world)).toBe(true);

    expect(world.player.burnTimer).toBe(0);
    expect(world.player.poisonStacks).toBe(0);
    world.player.burnTimer = 1;
    world.player.burnDps = 50;
    const hp = world.player.hp;
    stepSeconds(world, 0.5);
    expect(world.player.hp).toBe(hp);
  });
});

describe("сопротивление игрока", () => {
  it("гасит урон стихии и длительность её состояния, физический — нет", () => {
    const world = setup();
    resistAll(world, 0.5);
    let hp = world.player.hp;
    damagePlayer(world, 100, type("ember"));
    expect(hp - world.player.hp).toBeCloseTo(50, 5);
    expect(world.player.burnTimer).toBeCloseTo(PLAYER_BURN_SEC * 0.5, 5);

    hp = world.player.hp;
    world.player.burnTimer = 0;
    damagePlayer(world, 100, type("plain"));
    expect(hp - world.player.hp).toBeCloseTo(100, 5);
  });

  it("упирается в потолок: полной неуязвимости к стихии нет", () => {
    const world = setup();
    resistAll(world, 5);
    const hp = world.player.hp;
    damagePlayer(world, 100, type("frost"));
    expect(hp - world.player.hp).toBeCloseTo(100 * (1 - MAX_PLAYER_RESIST), 5);
    expect(world.player.chillTimer).toBeGreaterThan(0);
  });

  it("пассивка «всем стихиям» даёт все четыре, пассивка стихии — одну", () => {
    const types = resolvePassiveTypes([TEMPERING, { ...TEMPERING, id: "fireproof", stat: "resistFire", levels: [0.3] }]);
    const base = { maxHp: 100, pickupRadius: 50 };

    const all = computePlayerStats(base, types, new Map([[0, 1]]));
    expect([all.resistFire, all.resistCold, all.resistLightning, all.resistPoison]).toEqual([0.5, 0.5, 0.5, 0.5]);

    const both = computePlayerStats(base, types, new Map([[0, 1], [1, 1]]));
    expect(both.resistFire).toBeCloseTo(0.8, 5);
    expect(both.resistCold).toBe(0.5);
  });

  it("сопротивление-множитель и доля больше 0,9 — ошибка контента пассивки", () => {
    expect(findPassiveContentProblems([{ ...TEMPERING, op: "mul" }])).toEqual([expect.stringContaining("только слагаемым")]);
    expect(findPassiveContentProblems([{ ...TEMPERING, levels: [50] }])).toEqual([expect.stringContaining("доля от 0")]);
  });
});

describe("стихия атаки в контенте врага", () => {
  it("не-стихия и шанс без стихии или вне 0…1 — ошибка с именем врага", () => {
    expect(findEnemyContentProblems([EMBER, RARE])).toEqual([]);
    expect(findEnemyContentProblems([{ ...PLAIN, element: "physical" as never }])).toEqual([expect.stringContaining("plain: element")]);
    expect(findEnemyContentProblems([{ ...PLAIN, statusChance: 0.5 }])).toEqual([expect.stringContaining("plain: statusChance")]);
    expect(findEnemyContentProblems([{ ...EMBER, statusChance: 2 }])).toEqual([expect.stringContaining("ember: statusChance")]);
  });
});
