import type { LoadoutLimits } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CONTENT_SNAPSHOT } from "../src/content/snapshot";
import { isBuildComplete, simulateBalanceRun } from "../src/game/balance";
import { addPassive, addWeapon } from "../src/game/progression/loadout";
import { createWorld, type World } from "../src/game/sim/world";

// Счётчик «набор собран» (T-0193, Р127): все слоты заняты, всё на максимуме.
// Им меряется, когда бессмертный бот доводит сборку до конца.

const LIMITS: LoadoutLimits = { weapons: 2, passives: { attack: 1, defense: 1, mobility: 1 } };

/** Мир на боевом контенте с заданными слотами и пустым набором: уровни берутся из контента. */
function makeWorld(limits: LoadoutLimits = LIMITS): World {
  const world = createWorld({
    seed: 1,
    enemies: CONTENT_SNAPSHOT.enemies,
    weapons: CONTENT_SNAPSHOT.weapons,
    passives: CONTENT_SNAPSHOT.passives,
    levelCurve: CONTENT_SNAPSHOT.levelCurve,
    loadoutLimits: limits,
  });
  world.loadout.weapons.length = 0;
  world.loadout.passives.length = 0;
  return world;
}

function weaponIndex(world: World, id: string): number {
  const index = world.weaponTypes.findIndex((type) => type.id === id);
  if (index < 0) throw new Error(`нет оружия ${id}`);
  return index;
}

function passiveIndex(world: World, id: string): number {
  const index = world.passiveTypes.findIndex((type) => type.id === id);
  if (index < 0) throw new Error(`нет навыка ${id}`);
  return index;
}

/** Берёт оружие и сразу качает до предела. */
function giveWeapon(world: World, id: string): void {
  const index = weaponIndex(world, id);
  addWeapon(world.loadout, index).level = world.weaponTypes[index].levels.length;
}

function givePassive(world: World, id: string): void {
  const index = passiveIndex(world, id);
  addPassive(world.loadout, index).level = world.passiveTypes[index].levels.length;
}

/** Набор, собранный целиком под `LIMITS`. */
function completeWorld(): World {
  const world = makeWorld();
  giveWeapon(world, "spark");
  giveWeapon(world, "knife");
  givePassive(world, "might");
  givePassive(world, "vitality");
  givePassive(world, "swiftness");
  return world;
}

describe("isBuildComplete", () => {
  it("ложно на старте", () => {
    const world = createWorld({
      seed: 1,
      enemies: CONTENT_SNAPSHOT.enemies,
      weapons: CONTENT_SNAPSHOT.weapons,
      passives: CONTENT_SNAPSHOT.passives,
      levelCurve: CONTENT_SNAPSHOT.levelCurve,
      loadoutLimits: LIMITS,
    });
    expect(isBuildComplete(world)).toBe(false);
  });

  it("истинно, когда все слоты заняты и всё на максимуме", () => {
    expect(isBuildComplete(completeWorld())).toBe(true);
  });

  it("ложно, если один слот оружия свободен", () => {
    const world = completeWorld();
    world.loadout.weapons.pop();
    expect(isBuildComplete(world)).toBe(false);
  });

  it("ложно, если оружие не на максимуме", () => {
    const world = completeWorld();
    world.loadout.weapons[1].level--;
    expect(isBuildComplete(world)).toBe(false);
  });

  it("ложно, если слот навыка своей категории не занят", () => {
    for (const category of ["attack", "defense", "mobility"] as const) {
      const world = completeWorld();
      world.loadout.passives = world.loadout.passives.filter((slot) => world.passiveTypes[slot.typeIndex].category !== category);
      expect(isBuildComplete(world), category).toBe(false);
    }
  });

  it("ложно, если навык не на максимуме", () => {
    const world = completeWorld();
    world.loadout.passives[0].level--;
    expect(isBuildComplete(world)).toBe(false);
  });

  it("границы слотов берутся из мира, а не из глобальных пределов", () => {
    const world = completeWorld();
    world.loadoutLimits = { weapons: 3, passives: LIMITS.passives };
    expect(isBuildComplete(world)).toBe(false);

    const narrow = makeWorld({ weapons: 1, passives: { attack: 0, defense: 0, mobility: 0 } });
    giveWeapon(narrow, "spark");
    expect(isBuildComplete(narrow)).toBe(true);
  });

  it("оружие с одним уровнем (эволюция) считается собранным", () => {
    const evolved = CONTENT_SNAPSHOT.weapons.find((weapon) => weapon.evolvedFrom !== undefined);
    expect(evolved).toBeDefined();
    if (evolved === undefined) return;
    expect(evolved.levels).toHaveLength(1);

    const world = makeWorld({ weapons: 1, passives: { attack: 0, defense: 0, mobility: 0 } });
    addWeapon(world.loadout, weaponIndex(world, evolved.id));
    expect(isBuildComplete(world)).toBe(true);
  });
});

describe("счётчик сборки в симуляции баланса", () => {
  it("бессмертный бот живёт весь прогон, набор за две минуты не собирает", { timeout: 60_000 }, () => {
    const run = simulateBalanceRun({ seed: 1, skill: "dodging", godMode: true, maxSec: 120 });
    expect(run.timedOut).toBe(true);
    expect(run.survivalSec).toBeGreaterThanOrEqual(119.9);
    expect(run.buildCompleteSec).toBe(0);
    expect(run.buildPicks).toBeGreaterThan(0);
  });

  it("два прогона того же seed дают то же число", { timeout: 60_000 }, () => {
    const first = simulateBalanceRun({ seed: 4, skill: "dodging", godMode: true, maxSec: 90 });
    const second = simulateBalanceRun({ seed: 4, skill: "dodging", godMode: true, maxSec: 90 });
    expect(second).toEqual(first);
  });

  it("stopOnBuild останавливает прогон в секунду сборки", { timeout: 60_000 }, () => {
    // Контент, где набор собран с первого тика: один слот оружия, у оружия один
    // уровень, навыковых слотов нет.
    const spark = CONTENT_SNAPSHOT.weapons.find((weapon) => weapon.id === "spark");
    if (spark === undefined) throw new Error("нет искры");
    const content = {
      ...CONTENT_SNAPSHOT,
      weapons: [{ ...spark, levels: [spark.levels[0]] }],
      accountUnlocks: [],
      loadoutLimits: { weapons: 1, passives: { attack: 0, defense: 0, mobility: 0 } },
    };
    const run = simulateBalanceRun({ seed: 1, skill: "dodging", godMode: true, stopOnBuild: true, maxSec: 60, startingWeaponId: "spark", content });
    expect(run.buildCompleteSec).toBeGreaterThan(0);
    expect(run.buildCompleteSec).toBeLessThan(1);
    expect(run.survivalSec).toBe(run.buildCompleteSec);
    expect(run.timedOut).toBe(false);
  });
});
