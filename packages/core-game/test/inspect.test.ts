import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { addPassive, addWeapon } from "../src/game/progression/loadout";
import { refreshPlayerStats } from "../src/game/progression/levels";
import { inspectWorld } from "../src/game/run/inspect";
import { createWorld } from "../src/game/sim/create-world";

// Лист «Характеристики» (docs/27-design-system-and-app-shell.md §6): числа
// обязаны совпадать с тем, чем оружие бьёт на самом деле.

function worldAt(unitScale: number) {
  const world = createWorld({ seed: 3, enemies: ENEMIES, weapons: WEAPONS, passives: PASSIVES, startingWeaponId: "spark", config: { unitScale } });
  addWeapon(world.loadout, world.weaponTypes.findIndex((type) => type.id === "hearth"));
  const might = addPassive(world.loadout, world.passiveTypes.findIndex((type) => type.id === "might"));
  might.level = 2;
  addPassive(world.loadout, world.passiveTypes.findIndex((type) => type.id === "swiftness"));
  refreshPlayerStats(world);
  world.stats.elapsedSec = 100;
  world.stats.damageDealt = 1000;
  world.stats.damageByWeapon[0] = 750;
  world.stats.damageByWeapon[1] = 250;
  return world;
}

describe("характеристики забега", () => {
  it("показывает урон оружия с учётом пассивок, долю урона и урон в секунду", () => {
    const inspection = inspectWorld(worldAt(1));
    const spark = inspection.weapons[0];
    const sparkLevel = WEAPONS.find((weapon) => weapon.id === "spark")?.levels[0];

    expect(spark).toMatchObject({ id: "spark", level: 1, maxLevel: 5, damageShare: 0.75, dps: 7.5 });
    expect(spark?.damage).toBeCloseTo((sparkLevel?.damage ?? 0) * 1.2, 5);
    expect(inspection.player.damageMul).toBeCloseTo(1.2, 5);
    expect(inspection.passives.map((passive) => [passive.id, passive.level, passive.value])).toEqual([
      ["might", 2, 1.2],
      ["swiftness", 1, 1.08],
    ]);
  });

  it("не зависит от плотности экрана: скорость и радиусы — в игровых единицах", () => {
    const low = inspectWorld(worldAt(1));
    const high = inspectWorld(worldAt(3));

    expect(high.player.moveSpeed).toBeCloseTo(low.player.moveSpeed, 5);
    expect(high.player.pickupRadius).toBeCloseTo(low.player.pickupRadius, 5);
    expect(high.weapons[1]?.areaRadius).toBeCloseTo(low.weapons[1]?.areaRadius ?? 0, 5);
    expect(low.weapons[1]?.areaRadius).toBe(80);
  });
});
