import { describe, expect, it } from "vitest";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { BENCH_FULL_LOAD, equipFullLoadout, withEliteWaves } from "../src/game/bench/full-load";
import { killEnemy } from "../src/game/sim/combat";
import { createConstantPopulationSpawner } from "../src/game/sim/spawner";
import { stepWorld } from "../src/game/sim/step";
import { TICK_SEC, createWorld, spawnEnemy, type World } from "../src/game/sim/world";

// Нагрузка позднего забега для стресс-теста в оболочке (docs/28-diagnostics.md §2.3).

function world(config: Parameters<typeof createWorld>[0]["config"] = {}): World {
  return createWorld({
    seed: 7,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    drops: DROPS,
    map: MAPS[0],
    config: { progressionEnabled: false, ...config },
  });
}

describe("полная нагрузка стенда", () => {
  it("выдаёт всё оружие и все пассивки на последнем уровне", () => {
    const target = world({ lootEnabled: true });
    const baseMaxHp = target.player.maxHp;
    equipFullLoadout(target);

    expect(target.loadout.weapons.map((slot) => target.weaponTypes[slot.typeIndex]?.id).sort()).toEqual(
      WEAPONS.map((weapon) => weapon.id).sort(),
    );
    for (const slot of target.loadout.weapons) {
      expect(slot.level).toBe(target.weaponTypes[slot.typeIndex]?.levels.length);
    }
    expect(target.loadout.passives).toHaveLength(PASSIVES.length);
    for (const slot of target.loadout.passives) {
      expect(slot.level).toBe(target.passiveTypes[slot.typeIndex]?.levels.length);
    }
    // Характеристики пересчитаны сразу, а не на первом выборе улучшения.
    expect(target.player.maxHp).toBeGreaterThanOrEqual(baseMaxHp);
  });

  it("приводит волну элит по расписанию: обычный поток их не выпускает", () => {
    const target = world();
    const eliteTypes = target.enemyTypes.filter((type) => type.elite).length;
    expect(eliteTypes).toBeGreaterThan(0);

    const spawner = withEliteWaves(createConstantPopulationSpawner(0), BENCH_FULL_LOAD);
    const countElites = (): number => {
      let count = 0;
      for (let i = 0; i < target.enemies.count; i++) {
        if (target.enemies.alive[i] === 1 && target.enemyTypes[target.enemies.type[i]]?.elite === true) count++;
      }
      return count;
    };

    const ticksBeforeWave = Math.floor(BENCH_FULL_LOAD.eliteEverySec / TICK_SEC) - 2;
    for (let tick = 0; tick < ticksBeforeWave; tick++) {
      spawner.update(target, TICK_SEC);
      stepWorld(target, { moveX: 0, moveY: 0 });
    }
    expect(countElites()).toBe(0);

    for (let tick = 0; tick < 4; tick++) {
      spawner.update(target, TICK_SEC);
      stepWorld(target, { moveX: 0, moveY: 0 });
    }
    expect(countElites()).toBe(eliteTypes * BENCH_FULL_LOAD.elitesPerWave);
  });
});

describe("добыча без прокачки", () => {
  it("по умолчанию следует за прокачкой: стенд этапа 1 кристаллов не видит", () => {
    const target = world();
    expect(target.config.lootEnabled).toBe(false);
    const index = spawnEnemy(target, 0, 10, 0);
    killEnemy(target, index);
    expect(target.gems.aliveCount).toBe(0);
  });

  it("включённая отдельно роняет кристаллы, но уровни не предлагает", () => {
    const target = world({ lootEnabled: true });
    const index = spawnEnemy(target, 0, 10, 0);
    killEnemy(target, index);
    expect(target.gems.aliveCount).toBeGreaterThan(0);

    for (let tick = 0; tick < 600; tick++) stepWorld(target, { moveX: 0, moveY: 0 });
    expect(target.progression.offers).toHaveLength(0);
  });
});
