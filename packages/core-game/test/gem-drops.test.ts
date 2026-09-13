import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { DROPS } from "../src/content/drops";
import {
  dropGems,
  findDropsContentProblems,
  GEM_LAND_TICKS,
  isGemFlying,
  MAX_GEMS_PER_KILL,
  updateGems,
} from "../src/game/sim/gems";
import { TICK_SEC, createWorld, type World } from "../src/game/sim/world";

// Выпадение опыта: горсть кристаллов разной ценности с полётом от места смерти.

const DUMMY: EnemyDef = { id: "dummy", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
/** Без подборов: их броски сдвигали бы генератор, а тест про кристаллы. */
const NO_PICKUPS = {
  medkits: { chance: 0, eliteChance: 0, healRatio: 0.3, maxOnField: 0 },
  magnets: { chance: 0, eliteChance: 0, maxOnField: 0 },
  dynamite: { chance: 0, eliteChance: 0, maxOnField: 0, radiusUnits: 200, eliteHpRatio: 0.3 },
};

function setup(seed = 1, maxPerKill = 5): World {
  return createWorld({ seed, enemies: [DUMMY], drops: { gems: { maxPerKill }, ...NO_PICKUPS } });
}

function aliveGems(world: World): { value: number; x: number; y: number; flying: boolean }[] {
  const result = [];
  for (let i = 0; i < world.gems.count; i++) {
    if (world.gems.alive[i] === 0) continue;
    result.push({
      value: world.gems.value[i],
      x: world.gems.x[i],
      y: world.gems.y[i],
      flying: isGemFlying(world, i),
    });
  }
  return result;
}

describe("выпадение кристаллов", () => {
  it("сохраняет сумму опыта, на сколько бы кристаллов он ни разделился", () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const xp of [2, 3, 6, 25, 60]) {
        const world = setup(seed);
        dropGems(world, 0, 0, xp);
        const gems = aliveGems(world);

        expect(gems.reduce((sum, gem) => sum + gem.value, 0), `seed ${seed}, xp ${xp}`).toBe(xp);
        expect(gems.every((gem) => gem.value >= 1 && Number.isInteger(gem.value))).toBe(true);
        expect(gems.length).toBeGreaterThanOrEqual(1);
        expect(gems.length).toBeLessThanOrEqual(Math.min(xp, 5));
      }
    }
  });

  it("действительно даёт разное число кристаллов с одного и того же врага", () => {
    const counts = new Set<number>();
    for (let seed = 1; seed <= 30; seed++) {
      const world = setup(seed);
      dropGems(world, 0, 0, 25);
      counts.add(aliveGems(world).length);
    }
    expect(counts.size).toBeGreaterThan(2);
  });

  it("не трогает генератор, когда делить нечего: опыт 1 или потолок в один кристалл", () => {
    const world = setup(7);
    const stateBefore = world.rng.getState();
    dropGems(world, 0, 0, 1);
    // Одиночный кристалл всё равно разлетается — направление берётся из
    // генератора. Проверяем, что число кристаллов не тянуло лишних вызовов:
    // два одинаковых мира, где разница только в опыте 1 и потолке 1.
    const single = setup(7, 1);
    dropGems(single, 0, 0, 40);

    expect(world.rng.getState()).not.toBe(stateBefore);
    expect(single.rng.getState()).toBe(world.rng.getState());
  });

  it("одинаковый seed — одинаковая горсть", () => {
    const first = setup(11);
    const second = setup(11);
    dropGems(first, 5, -3, 60);
    dropGems(second, 5, -3, 60);
    expect(aliveGems(first)).toEqual(aliveGems(second));
  });

  it("разлетается от места смерти, а не падает стопкой в одну точку", () => {
    const world = setup(3);
    dropGems(world, 100, 100, 60);
    const gems = aliveGems(world);
    const spots = new Set(gems.map((gem) => `${gem.x.toFixed(1)}:${gem.y.toFixed(1)}`));

    expect(spots.size).toBe(gems.length);
    for (const gem of gems) {
      expect(Math.hypot(gem.x - 100, gem.y - 100)).toBeLessThanOrEqual(30 + 1e-9);
    }
  });

  it("в полёте не подбирается, даже упав прямо на игрока, а после приземления — да", () => {
    const world = setup(5);
    dropGems(world, world.player.x, world.player.y, 1);

    updateGems(world, TICK_SEC);
    expect(world.progression.totalXp).toBe(0);
    expect(aliveGems(world)[0]?.flying).toBe(true);

    world.stats.tick += GEM_LAND_TICKS;
    updateGems(world, TICK_SEC);
    expect(world.progression.totalXp).toBe(1);
  });
});

describe("контент выпадения", () => {
  it("боевой контент корректен", () => {
    expect(findDropsContentProblems(DROPS)).toEqual([]);
  });

  it("называет поле и допустимые границы", () => {
    expect(findDropsContentProblems({ gems: { maxPerKill: 0 }, ...NO_PICKUPS }).join("\n")).toMatch(/maxPerKill/);
    expect(findDropsContentProblems({ gems: { maxPerKill: MAX_GEMS_PER_KILL + 1 }, ...NO_PICKUPS })).toHaveLength(1);
    expect(findDropsContentProblems({ gems: { maxPerKill: 2.5 }, ...NO_PICKUPS })).toHaveLength(1);
  });

  it("мир с некорректным выпадением не создаётся", () => {
    expect(() => createWorld({ seed: 1, enemies: [DUMMY], drops: { gems: { maxPerKill: 0 }, ...NO_PICKUPS } })).toThrow(
      /выпадения/,
    );
  });
});
