import type { EnemyPattern } from "@bh/shared-types";
import { spawnProjectile, type World } from "../sim/world";

/**
 * Реализация паттернов поведения врагов. Новый паттерн — это код, его
 * добавляет участник 1. Геймдизайнер выбирает готовый паттерн в
 * content/enemies.ts и сюда не заходит (docs/01-tech-stack.md §9).
 *
 * Паттерн работает поверх пулов симуляции и не знает про Phaser: рендер
 * отделён от логики, иначе симуляцию нельзя прогнать headless
 * (docs/17-testing-strategy.md §3.0).
 *
 * Контракт: паттерн задаёт vx/vy врага и может стрелять. Перемещение,
 * коллизии и урон — не его дело, этим занимается step().
 */
export type PatternImpl = (world: World, index: number, dtSec: number) => void;

/** Дистанция, которую стрелок старается держать до игрока. */
const KITE_PREFERRED_DISTANCE = 220;
/** Мёртвая зона вокруг желаемой дистанции — без неё стрелок дрожит на месте. */
const KITE_DEADZONE = 24;
const KITE_SHOT_INTERVAL_SEC = 2.2;
const KITE_PROJECTILE_SPEED = 260;
const KITE_PROJECTILE_TTL_SEC = 4;

/** Насколько быстро chase доворачивает скорость к желаемой, доля в секунду. */
const CHASE_STEERING_PER_SEC = 3.2;

export const PATTERNS: Record<EnemyPattern, PatternImpl> = {
  /** Прямо на игрока на полной скорости — самый дешёвый и самый массовый. */
  swarm: (world, index, _dtSec) => {
    const enemies = world.enemies;
    const speed = world.enemyTypes[enemies.type[index]].speed;
    const dx = world.player.x - enemies.x[index];
    const dy = world.player.y - enemies.y[index];
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-3) {
      enemies.vx[index] = 0;
      enemies.vy[index] = 0;
      return;
    }
    enemies.vx[index] = (dx / distance) * speed;
    enemies.vy[index] = (dy / distance) * speed;
  },

  /**
   * Медленное, но настойчивое преследование: скорость доворачивается к
   * направлению на игрока не мгновенно. Инерция — единственное, что отличает
   * chase от swarm на глаз, без неё оба паттерна выглядят одинаково.
   */
  chase: (world, index, dtSec) => {
    const enemies = world.enemies;
    const speed = world.enemyTypes[enemies.type[index]].speed;
    const dx = world.player.x - enemies.x[index];
    const dy = world.player.y - enemies.y[index];
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-3) return;

    const desiredVx = (dx / distance) * speed;
    const desiredVy = (dy / distance) * speed;
    const steering = Math.min(1, CHASE_STEERING_PER_SEC * dtSec);
    enemies.vx[index] += (desiredVx - enemies.vx[index]) * steering;
    enemies.vy[index] += (desiredVy - enemies.vy[index]) * steering;
  },

  /**
   * Держит дистанцию и стреляет. Даёт симуляции вторую популяцию снарядов —
   * для FPS-испытания это важно: враги-снаряды нагружают пул и коллизии
   * иначе, чем сами враги.
   */
  kite_and_shoot: (world, index, dtSec) => {
    const enemies = world.enemies;
    const type = world.enemyTypes[enemies.type[index]];
    const dx = world.player.x - enemies.x[index];
    const dy = world.player.y - enemies.y[index];
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-3) return;

    const nx = dx / distance;
    const ny = dy / distance;

    // Дистанции и скорости паттерна заданы в игровых единицах и приводятся
    // к пикселям устройства тем же множителем, что и остальной мир.
    const scale = world.config.unitScale;
    const preferred = KITE_PREFERRED_DISTANCE * scale;
    const deadzone = KITE_DEADZONE * scale;

    if (distance > preferred + deadzone) {
      enemies.vx[index] = nx * type.speed;
      enemies.vy[index] = ny * type.speed;
    } else if (distance < preferred - deadzone) {
      enemies.vx[index] = -nx * type.speed;
      enemies.vy[index] = -ny * type.speed;
    } else {
      enemies.vx[index] = 0;
      enemies.vy[index] = 0;
    }

    enemies.attackCooldown[index] -= dtSec;
    if (enemies.attackCooldown[index] <= 0) {
      enemies.attackCooldown[index] = KITE_SHOT_INTERVAL_SEC;
      spawnProjectile(
        world,
        enemies.x[index],
        enemies.y[index],
        nx * KITE_PROJECTILE_SPEED * scale,
        ny * KITE_PROJECTILE_SPEED * scale,
        type.damage,
        KITE_PROJECTILE_TTL_SEC,
        false,
      );
    }
  },
};

export function applyPattern(
  pattern: EnemyPattern,
  world: World,
  index: number,
  dtSec: number,
): void {
  PATTERNS[pattern](world, index, dtSec);
}

/** Список реализованных паттернов — на него опирается тест контента (§3.1). */
export const IMPLEMENTED_PATTERNS = Object.keys(PATTERNS) as EnemyPattern[];
