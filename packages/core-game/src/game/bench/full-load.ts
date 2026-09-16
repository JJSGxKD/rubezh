import { isElite } from "../patterns";
import type { EnemyPattern } from "@bh/shared-types";
import { refreshPlayerStats } from "../progression/levels";
import { addPassive, addWeapon, passiveSlotOf, weaponSlotOf } from "../progression/loadout";
import { spawnRandomOnRing, type Spawner } from "../sim/spawner";
import type { World } from "../sim/world";

/**
 * Нагрузка сегодняшнего забега для стресс-теста в оболочке
 * (docs/28-diagnostics.md §2.3).
 *
 * Стенд этапа 1 мерил мир с одним стартовым оружием и тремя паттернами —
 * тогда ничего другого в игре не было. К закрытому тесту поздний забег —
 * это пять видов оружия на максимуме, аура и молнии, семь паттернов с
 * телеграфами, элиты, кристаллы и подборы. Замер без них отвечал бы на
 * вопрос, которого игрок не задаёт.
 *
 * Модуль не реэкспортируется из `bench/index.ts`: он тянет симуляцию, а
 * индекс стенда читает оболочка ради типов отчёта.
 */

export interface FullLoadPreset {
  /** доли паттернов в потоке: рой по-прежнему основа толпы */
  weights: Partial<Record<EnemyPattern, number>>;
  /** как часто приходит волна элит — они крупнее, светлее и с телеграфами */
  eliteEverySec: number;
  /** сколько врагов каждого элитного типа в волне */
  elitesPerWave: number;
}

export const BENCH_FULL_LOAD: FullLoadPreset = {
  weights: { swarm: 6, chase: 2, kite_and_shoot: 2, dash: 1, orbit: 1, exploder: 1, splitter: 1 },
  eliteEverySec: 20,
  elitesPerWave: 2,
};

/**
 * Всё оружие и все пассивки на последнем уровне — худший для устройства
 * случай позднего забега. Лимиты слотов здесь сознательно не соблюдаются:
 * игрок столько не соберёт, но и запас меряется не ровно по игроку.
 */
export function equipFullLoadout(world: World): void {
  world.weaponTypes.forEach((type, typeIndex) => {
    const existing = weaponSlotOf(world.loadout, typeIndex);
    const slot = existing >= 0 ? world.loadout.weapons[existing] : addWeapon(world.loadout, typeIndex);
    if (slot !== undefined) slot.level = type.levels.length;
  });
  world.passiveTypes.forEach((type, typeIndex) => {
    const existing = passiveSlotOf(world.loadout, typeIndex);
    const slot = existing >= 0 ? world.loadout.passives[existing] : addPassive(world.loadout, typeIndex);
    if (slot !== undefined) slot.level = type.levels.length;
  });
  refreshPlayerStats(world);
}

/**
 * Волны элит поверх любого спавнера. Обычный поток элит не выпускает — их
 * место в игре событие таймлайна, — поэтому стенд приводит их сам.
 */
export function withEliteWaves(inner: Spawner, preset: FullLoadPreset): Spawner {
  let nextWaveSec = preset.eliteEverySec;
  return {
    update(world, dtSec) {
      inner.update(world, dtSec);
      if (world.stats.elapsedSec < nextWaveSec) return;
      nextWaveSec += preset.eliteEverySec;
      world.enemyTypes.forEach((type, typeIndex) => {
        if (!isElite(type)) return;
        for (let i = 0; i < preset.elitesPerWave; i++) spawnRandomOnRing(world, typeIndex);
      });
    },
  };
}
