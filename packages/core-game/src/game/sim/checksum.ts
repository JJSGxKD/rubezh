import type { World } from "./world";

/**
 * Свёртка позиций и статистики в 32-битное число. Сравнение точное, без
 * допусков: цель — заметить любое расхождение, а не оценить его величину.
 *
 * Ею сверяются два прогона в тестах детерминизма и повтор забега тестера с
 * оригиналом (docs/28-diagnostics.md §3.4) — поэтому она в исходниках, а не в
 * тестах: запись забега на устройстве считает её той же функцией.
 */
export function checksumWorld(world: World): number {
  let hash = 2166136261;
  const fold = (value: number): void => {
    hash = Math.imul(hash ^ Math.round(value * 1000), 16777619) | 0;
  };

  fold(world.player.x);
  fold(world.player.y);
  fold(world.player.hp);
  fold(world.stats.enemiesSpawned);
  fold(world.stats.enemiesKilled);
  fold(world.stats.damageTaken);
  fold(world.stats.shotsFired);
  fold(world.stats.deathCauseType);
  fold(world.stats.distance);
  for (const kills of world.stats.killsByType) fold(kills);

  // Прокачка — часть состояния забега: без неё расхождение в выборе
  // улучшений или в опыте осталось бы незамеченным.
  fold(world.progression.level);
  fold(world.progression.xp);
  fold(world.progression.totalXp);
  for (const weapon of world.loadout.weapons) {
    fold(weapon.typeIndex);
    fold(weapon.level);
    fold(weapon.cooldown);
  }
  for (const passive of world.loadout.passives) {
    fold(passive.typeIndex);
    fold(passive.level);
  }
  for (let i = 0; i < world.gems.count; i++) {
    fold(world.gems.alive[i]);
    if (world.gems.alive[i] === 0) continue;
    fold(world.gems.x[i]);
    fold(world.gems.y[i]);
    fold(world.gems.value[i]);
  }

  for (let i = 0; i < world.enemies.count; i++) {
    fold(world.enemies.alive[i]);
    if (world.enemies.alive[i] === 0) continue;
    fold(world.enemies.x[i]);
    fold(world.enemies.y[i]);
    fold(world.enemies.hp[i]);
    fold(world.enemies.phase[i]);
    fold(world.enemies.ringRadius[i]);
  }
  return hash;
}
