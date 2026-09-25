import type { EnemyDef, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { findEnemyContentProblems } from "../src/game/patterns/enemy-types";
import { damageEnemy } from "../src/game/sim/combat";
import {
  BURN_DPS_SHARE,
  BURN_SEC,
  CHAIN_RADIUS,
  CHAIN_SHARE,
  ELEMENT_COLD,
  ELEMENT_FIRE,
  ELEMENT_LIGHTNING,
  ELEMENT_PHYSICAL,
  ELEMENT_POISON,
  FREEZE_BUILD,
  POISON_MAX_STACKS,
  SHOCK_BONUS,
  elementIndex,
} from "../src/game/sim/elements";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, DEFAULT_SIM_CONFIG, despawnEnemy, spawnEnemy, TICK_SEC, type World } from "../src/game/sim/world";
import { findWeaponContentProblems } from "../src/game/weapons";

/**
 * Стихии и состояния в симуляции (docs/35-stage4-plan.md, §3.3, WP6).
 * Критерий приёмки: стихийное оружие ощутимо сильнее против уязвимого врага и
 * слабее против стойкого, а повтор забега со стихиями совпадает — состояния
 * тикают вместе с миром, шанс идёт через генератор забега.
 */

const DUMMY: EnemyDef = { id: "dummy", hp: 10_000, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const SALAMANDER: EnemyDef = { id: "salamander", hp: 10_000, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", resist: { fire: 0.5, cold: -0.5 } };
const BOSS: EnemyDef = { id: "boss", hp: 100_000, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", rank: "boss" };
const WALKER: EnemyDef = { id: "walker", hp: 10_000, speed: 60, damage: 10, xp: 1, pattern: "swarm" };
const INSULATED: EnemyDef = { id: "insulated", hp: 10_000, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", resist: { lightning: 0.5 } };

function setup(seed = 1): World {
  return createWorld({
    seed,
    enemies: [DUMMY, SALAMANDER, BOSS, WALKER, INSULATED],
    weapons: [],
    config: { player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 10_000 } },
  });
}

function place(world: World, id: string, x = 300, y = 0): number {
  const slot = spawnEnemy(world, world.enemyTypes.findIndex((type) => type.id === id), x, y);
  if (slot < 0) throw new Error("пул исчерпан");
  return slot;
}

const lost = (world: World, index: number, before: number) => before - world.enemies.hp[index];

describe("сопротивления", () => {
  it("стойкий к огню получает вдвое меньше, уязвимый к холоду — в полтора раза больше", () => {
    const world = setup();
    const plain = place(world, "dummy");
    const salamander = place(world, "salamander", -300);
    const hp = world.enemies.hp[plain];

    damageEnemy(world, plain, 100, 0, ELEMENT_FIRE);
    damageEnemy(world, salamander, 100, 0, ELEMENT_FIRE);
    expect(lost(world, plain, hp)).toBe(100);
    expect(lost(world, salamander, hp)).toBe(50);

    damageEnemy(world, salamander, 100, 0, ELEMENT_COLD);
    expect(lost(world, salamander, hp)).toBe(50 + 150);
  });

  it("физический урон сопротивлением не гасится", () => {
    const world = setup();
    const salamander = place(world, "salamander");
    const hp = world.enemies.hp[salamander];
    damageEnemy(world, salamander, 100, 0, ELEMENT_PHYSICAL);
    expect(lost(world, salamander, hp)).toBe(100);
  });

  it("сопротивление вне коридора и не-стихия — ошибка контента с именем врага и поля", () => {
    expect(findEnemyContentProblems([{ ...DUMMY, resist: { fire: 1 } }])).toEqual([expect.stringContaining("dummy: resist.fire")]);
    expect(findEnemyContentProblems([{ ...DUMMY, resist: { poison: -2 } }])).toHaveLength(1);
    expect(findEnemyContentProblems([{ ...DUMMY, resist: { physical: 0.5 } as never }])).toEqual([expect.stringContaining("resist.physical")]);
  });
});

describe("шанс и генератор", () => {
  it("урон без шанса генератор не трогает — прежние забеги не расходятся с эталонами", () => {
    const touched = setup(7);
    const untouched = setup(7);
    damageEnemy(touched, place(touched, "dummy"), 10, 0, ELEMENT_FIRE, 0);
    place(untouched, "dummy");
    expect(touched.rng.nextFloat()).toBe(untouched.rng.nextFloat());
  });

  it("одинаковый seed — одинаковые наложения", () => {
    const outcomes = [setup(3), setup(3)].map((world) => {
      const enemy = place(world, "dummy");
      for (let hit = 0; hit < 20; hit++) damageEnemy(world, enemy, 10, 0, ELEMENT_POISON, 0.5);
      return world.enemies.poisonStacks[enemy];
    });
    expect(outcomes[0]).toBe(outcomes[1]);
    expect(outcomes[0]).toBeGreaterThan(0);
    expect(outcomes[0]).toBeLessThan(POISON_MAX_STACKS + 1);
  });
});

describe("состояния", () => {
  it("горение не складывается: обновляет длительность и берёт больший урон", () => {
    const world = setup();
    const enemy = place(world, "dummy");
    damageEnemy(world, enemy, 100, 0, ELEMENT_FIRE, 1);
    damageEnemy(world, enemy, 40, 0, ELEMENT_FIRE, 1);
    expect(world.enemies.burnDps[enemy]).toBe(100 * BURN_DPS_SHARE);
    expect(world.enemies.burnTimer[enemy]).toBe(BURN_SEC);
  });

  it("горение жжёт по времени и гаснет; урон засчитан оружию, которое подожгло", () => {
    const world = setup();
    const enemy = place(world, "dummy");
    world.stats.damageByWeapon[0] = 0;
    damageEnemy(world, enemy, 100, 0, ELEMENT_FIRE, 1);
    const afterHit = world.enemies.hp[enemy];

    const ticks = Math.ceil(BURN_SEC / TICK_SEC) + 5;
    for (let tick = 0; tick < ticks; tick++) stepWorld(world, IDLE_INPUT);

    expect(afterHit - world.enemies.hp[enemy]).toBeCloseTo(100 * BURN_DPS_SHARE * BURN_SEC, 3);
    expect(world.enemies.burnTimer[enemy]).toBe(0);
    expect(world.stats.damageByWeapon[0]).toBeCloseTo(100 + 100 * BURN_DPS_SHARE * BURN_SEC, 3);
  });

  it("серия охлаждений замораживает, босса — никогда", () => {
    const world = setup();
    const enemy = place(world, "dummy");
    const boss = place(world, "boss", -300);
    for (let hit = 0; hit < FREEZE_BUILD; hit++) {
      damageEnemy(world, enemy, 1, 0, ELEMENT_COLD, 1);
      damageEnemy(world, boss, 1, 0, ELEMENT_COLD, 1);
    }
    expect(world.enemies.frozenTimer[enemy]).toBeGreaterThan(0);
    expect(world.enemies.frozenTimer[boss]).toBe(0);
    expect(world.enemies.chillTimer[boss]).toBeGreaterThan(0);
  });

  it("замороженный стоит и не бьёт, охлаждённый — медленнее", () => {
    const world = setup();
    const frozen = place(world, "walker", 40, 0);
    const chilled = place(world, "walker", 0, 400);
    const free = place(world, "walker", 0, -400);
    for (let hit = 0; hit < FREEZE_BUILD; hit++) damageEnemy(world, frozen, 1, 0, ELEMENT_COLD, 1);
    damageEnemy(world, chilled, 1, 0, ELEMENT_COLD, 1);
    const start = { frozen: world.enemies.x[frozen], chilled: world.enemies.y[chilled], free: world.enemies.y[free] };
    const hp = world.player.hp;

    for (let tick = 0; tick < 10; tick++) stepWorld(world, IDLE_INPUT);

    expect(world.enemies.x[frozen]).toBe(start.frozen);
    expect(world.player.hp).toBe(hp);
    const chilledMoved = Math.abs(world.enemies.y[chilled] - start.chilled);
    const freeMoved = Math.abs(world.enemies.y[free] - start.free);
    expect(chilledMoved).toBeGreaterThan(0);
    expect(chilledMoved).toBeLessThan(freeMoved);
  });

  it("шокированный получает больше урона от всего, и физического тоже", () => {
    const world = setup();
    const enemy = place(world, "dummy");
    damageEnemy(world, enemy, 1, 0, ELEMENT_LIGHTNING, 1);
    const hp = world.enemies.hp[enemy];
    damageEnemy(world, enemy, 100, 0, ELEMENT_PHYSICAL);
    expect(lost(world, enemy, hp)).toBeCloseTo(100 * (1 + SHOCK_BONUS), 5);
  });

  it("яд складывается слоями до потолка", () => {
    const world = setup();
    const enemy = place(world, "dummy");
    for (let hit = 0; hit < POISON_MAX_STACKS + 5; hit++) damageEnemy(world, enemy, 10, 0, ELEMENT_POISON, 1);
    expect(world.enemies.poisonStacks[enemy]).toBe(POISON_MAX_STACKS);
  });

  it("новый враг в слоте не наследует состояния прежнего", () => {
    const world = setup();
    const enemy = place(world, "dummy");
    damageEnemy(world, enemy, 100, 0, ELEMENT_FIRE, 1);
    damageEnemy(world, enemy, 100, 0, ELEMENT_POISON, 1);
    despawnEnemy(world, enemy);
    const reused = place(world, "dummy");
    expect(reused).toBe(enemy);
    expect(world.enemies.burnTimer[reused]).toBe(0);
    expect(world.enemies.poisonStacks[reused]).toBe(0);
  });
});

describe("перескок молнии", () => {
  /** Сетку строит шаг мира; в тесте без шага её перестраивают руками. */
  function rebuildGrid(world: World): void {
    const enemies = world.enemies;
    world.enemyGrid.rebuild(world.player.x, world.player.y, enemies.x, enemies.y, enemies.alive, enemies.count);
  }

  function crowd(world: World) {
    const reach = CHAIN_RADIUS * world.config.unitScale;
    const target = place(world, "dummy", 300, 0);
    const nearest = place(world, "dummy", 300 + reach * 0.2, 0);
    const second = place(world, "dummy", 300, reach * 0.4);
    const third = place(world, "dummy", 300 - reach * 0.7, 0);
    const outside = place(world, "dummy", 300 + reach * 1.2, 0);
    rebuildGrid(world);
    return { target, nearest, second, third, outside };
  }

  it("удар по шокированному бьёт двух ближайших долей удара, остальных — нет", () => {
    const world = setup();
    const { target, nearest, second, third, outside } = crowd(world);
    const hp = world.enemies.hp[nearest];
    damageEnemy(world, target, 1, 0, ELEMENT_LIGHTNING, 1);
    damageEnemy(world, target, 100, 0, ELEMENT_LIGHTNING);

    expect(lost(world, nearest, hp)).toBeCloseTo(100 * CHAIN_SHARE, 5);
    expect(lost(world, second, hp)).toBeCloseTo(100 * CHAIN_SHARE, 5);
    expect(lost(world, third, hp)).toBe(0);
    expect(lost(world, outside, hp)).toBe(0);
  });

  it("удар, который шок только наложил, и не-молния по шокированному не перескакивают", () => {
    const world = setup();
    const { target, nearest } = crowd(world);
    const hp = world.enemies.hp[nearest];
    damageEnemy(world, target, 100, 0, ELEMENT_LIGHTNING, 1);
    damageEnemy(world, target, 100, 0, ELEMENT_FIRE);
    damageEnemy(world, target, 100, 0, ELEMENT_PHYSICAL);
    expect(lost(world, nearest, hp)).toBe(0);
  });

  it("перескок гасится стойкостью соседа к молнии", () => {
    const world = setup();
    const reach = CHAIN_RADIUS * world.config.unitScale;
    const target = place(world, "dummy", 300, 0);
    const insulated = place(world, "insulated", 300 + reach * 0.3, 0);
    rebuildGrid(world);
    const hp = world.enemies.hp[insulated];
    damageEnemy(world, target, 1, 0, ELEMENT_LIGHTNING, 1);
    damageEnemy(world, target, 100, 0, ELEMENT_LIGHTNING);
    expect(lost(world, insulated, hp)).toBeCloseTo(100 * CHAIN_SHARE * 0.5, 5);
  });

  it("добивающий удар тоже перескакивает — от места, где стоял враг", () => {
    const world = setup();
    const { target, nearest } = crowd(world);
    const hp = world.enemies.hp[nearest];
    damageEnemy(world, target, 1, 0, ELEMENT_LIGHTNING, 1);
    world.enemies.hp[target] = 1;
    damageEnemy(world, target, 100, 0, ELEMENT_LIGHTNING);
    expect(world.enemies.alive[target]).toBe(0);
    expect(lost(world, nearest, hp)).toBeCloseTo(100 * CHAIN_SHARE, 5);
  });
});

describe("стихия в контенте оружия", () => {
  const base: WeaponDef = { id: "flame", behavior: "aura", nameKey: "n", descriptionKey: "d", starting: true, element: "fire", levels: [{ damage: 5, cooldownSec: 1, statusChance: 0.2 }] };

  it("стихия и шанс проходят проверку, индекс стихии — по её месту в перечне", () => {
    expect(findWeaponContentProblems([base])).toEqual([]);
    expect(elementIndex("fire")).toBe(ELEMENT_FIRE);
    expect(elementIndex(undefined)).toBe(ELEMENT_PHYSICAL);
  });

  it("шанс вне 0…1 и шанс без стихии — ошибка контента", () => {
    expect(findWeaponContentProblems([{ ...base, levels: [{ damage: 5, cooldownSec: 1, statusChance: 1.5 }] }])).toEqual([expect.stringContaining("flame: element или statusChance")]);
    expect(findWeaponContentProblems([{ ...base, element: undefined }])).toEqual([expect.stringContaining("только со стихией")]);
  });
});
