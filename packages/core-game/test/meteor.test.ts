import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS, WEAPON_EVOLUTIONS } from "../src/content/weapons";
import { EVOLUTION_POWER_RATIO } from "../src/content/balance-targets";
import { findEvolutionProblems, weaponPowerIndex } from "../src/game/progression/evolutions";
import { findWeaponContentProblems } from "../src/game/weapons";
import { meteorTrail } from "../src/game/render/weapon-effects";
import { SIM_EVENT } from "../src/game/sim/events";
import { checksumWorld } from "../src/game/sim/checksum";
import { addPassive, addWeapon, weaponSlotOf } from "../src/game/progression/loadout";
import { openChest } from "../src/game/sim/chests";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";

// «Метеор» — седьмое базовое оружие и его эволюция «Огненный ливень»
// (tasks/T-0118): данные на готовом поведении `area_strike`, огонь вместо
// грозы, и свой вид события для рендера.

function world(weaponId: string, seed = 11): World {
  return createWorld({ seed, enemies: ENEMIES, weapons: WEAPONS, passives: PASSIVES, levelCurve: LEVEL_CURVE, loadoutLimits: LOADOUT_LIMITS, drops: DROPS, chests: CHESTS, startingWeaponId: weaponId });
}

function withEnemy(target: World, x = 120, y = 0, id = "swarm_rat"): number {
  const slot = spawnEnemy(target, target.enemyTypes.findIndex((type) => type.id === id), x, y);
  if (slot < 0) throw new Error("пул исчерпан");
  return slot;
}

function eventKinds(target: World): number[] {
  return Array.from(target.events.kind.slice(0, Math.min(target.events.written, target.events.kind.length)));
}

describe("данные «Метеора»", () => {
  const meteor = WEAPONS.find((weapon) => weapon.id === "meteor");
  const rain = WEAPONS.find((weapon) => weapon.id === "fire_rain");

  it("контент проходит проверки; у оружия 8 уровней, у эволюции один, поведение и стихия те же", () => {
    expect(findWeaponContentProblems(WEAPONS)).toEqual([]);
    expect(findEvolutionProblems(WEAPONS, PASSIVES.map((passive) => passive.id))).toEqual([]);
    expect(meteor?.levels).toHaveLength(8);
    expect(rain?.levels).toHaveLength(1);
    expect(meteor?.behavior).toBe("area_strike");
    expect(meteor?.element).toBe("fire");
    expect(rain?.behavior).toBe(meteor?.behavior);
    expect(rain?.element).toBe(meteor?.element);
    expect(rain?.evolvedFrom).toBe("meteor");
    expect(rain?.recipe).toEqual({ passive: "reach" });
  });

  it("сила эволюции — в коридоре относительно максимума базового", () => {
    const top = meteor?.levels.at(-1);
    const only = rain?.levels[0];
    if (top === undefined || only === undefined) throw new Error("нет уровней");
    const ratio = weaponPowerIndex(only) / weaponPowerIndex(top);
    expect(ratio).toBeGreaterThanOrEqual(EVOLUTION_POWER_RATIO.min);
    expect(ratio).toBeLessThanOrEqual(EVOLUTION_POWER_RATIO.max);
  });

  it("базовое стоит после «Жала» и до всех эволюций, «Ливень» — последний", () => {
    const ids = WEAPONS.map((weapon) => weapon.id);
    expect(ids.indexOf("meteor")).toBe(ids.indexOf("sting") + 1);
    expect(ids.indexOf("meteor")).toBeLessThan(ids.indexOf(WEAPON_EVOLUTIONS[0]?.id ?? ""));
    expect(ids.at(-1)).toBe("fire_rain");
  });
});

describe("вид удара", () => {
  it("огненное оружие пишет strikeFire, гроза — прежний strike", () => {
    const fire = world("meteor");
    withEnemy(fire);
    for (let tick = 0; tick < 400 && !eventKinds(fire).includes(SIM_EVENT.strikeFire); tick++) stepWorld(fire, IDLE_INPUT);
    expect(eventKinds(fire)).toContain(SIM_EVENT.strikeFire);
    expect(eventKinds(fire)).not.toContain(SIM_EVENT.strike);

    const storm = world("storm");
    withEnemy(storm);
    for (let tick = 0; tick < 400 && !eventKinds(storm).includes(SIM_EVENT.strike); tick++) stepWorld(storm, IDLE_INPUT);
    expect(eventKinds(storm)).toContain(SIM_EVENT.strike);
    expect(eventKinds(storm)).not.toContain(SIM_EVENT.strikeFire);
  });

  it("вид события не входит в контрольную сумму: симуляция от него не зависит", () => {
    const a = world("storm");
    const b = world("storm");
    withEnemy(a);
    withEnemy(b);
    for (let tick = 0; tick < 300; tick++) {
      stepWorld(a, IDLE_INPUT);
      stepWorld(b, IDLE_INPUT);
    }
    b.events.kind.fill(SIM_EVENT.strikeFire);
    expect(checksumWorld(b)).toBe(checksumWorld(a));
  });

  it("две «Метеор»-игры с одним seed дают одну сумму", () => {
    const run = (): number => {
      const target = world("meteor", 5);
      withEnemy(target);
      for (let tick = 0; tick < 600; tick++) stepWorld(target, IDLE_INPUT);
      return checksumWorld(target);
    };
    expect(run()).toBe(run());
  });

  it("враг в радиусе удара загорается при шансе 1, за радиусом — нет", () => {
    const target = world("meteor");
    const typeIndex = target.weaponTypes.findIndex((type) => type.id === "meteor");
    const level = target.weaponTypes[typeIndex]?.levels[0];
    if (level === undefined) throw new Error("нет уровня");
    level.statusChance = 1;
    // Живучие враги: удар не убивает их, и горение успевает наложиться.
    const near = withEnemy(target, 60, 0, "tank_ghoul");
    const far = withEnemy(target, 900, 0, "tank_ghoul");
    for (let tick = 0; tick < 400 && target.events.written === 0; tick++) stepWorld(target, IDLE_INPUT);
    expect(target.events.written).toBeGreaterThan(0);

    // Центр удара выбирает генератор: горит тот, кто ближе к центру, второй — нет.
    const centerX = target.events.x[0] ?? 0;
    const [hit, missed] = Math.abs(target.enemies.x[near] - centerX) < Math.abs(target.enemies.x[far] - centerX) ? [near, far] : [far, near];
    expect(target.enemies.burnTimer[hit]).toBeGreaterThan(0);
    expect(target.enemies.burnTimer[missed]).toBe(0);
  });
});

describe("траектория падения", () => {
  it("одинаковые входы дают одинаковые точки и не требуют генератора", () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error("Math.random в рендере метеора");
    };
    try {
      expect(meteorTrail(100, 200, 90, 7)).toEqual(meteorTrail(100, 200, 90, 7));
    } finally {
      Math.random = original;
    }
  });

  it("падает сверху-справа к точке удара, длина растёт с радиусом", () => {
    const small = meteorTrail(0, 0, 60, 1);
    const large = meteorTrail(0, 0, 120, 1);
    expect(small.fromX).toBeGreaterThan(0);
    expect(small.fromY).toBeLessThan(0);
    expect(Math.hypot(large.fromX, large.fromY)).toBeGreaterThan(Math.hypot(small.fromX, small.fromY));
  });
});

describe("эволюция «Метеора»", () => {
  it("сундук с готовым рецептом (8-й уровень и «Дальнобойность») выдаёт «Огненный ливень» в том же слоте", () => {
    const target = world("meteor");
    const meteorIndex = target.weaponTypes.findIndex((type) => type.id === "meteor");
    const reachIndex = target.passiveTypes.findIndex((type) => type.id === "reach");
    const slot = weaponSlotOf(target.loadout, meteorIndex);
    (slot >= 0 ? target.loadout.weapons[slot] : addWeapon(target.loadout, meteorIndex)).level = 8;
    addPassive(target.loadout, reachIndex);

    openChest(target, 3);

    expect(target.chests.openings[0]?.rewards[0]).toMatchObject({ kind: "weapon_evolve", refId: "fire_rain" });
    const rainIndex = target.weaponTypes.findIndex((type) => type.id === "fire_rain");
    expect(weaponSlotOf(target.loadout, rainIndex)).toBeGreaterThanOrEqual(0);
    expect(weaponSlotOf(target.loadout, meteorIndex)).toBe(-1);
  });
});
