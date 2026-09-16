import { spawnProjectile } from "../sim/world";
import type { PatternBehavior } from "./behavior";
import { createHeading, enemySpeed, headingToPlayer, MIN_HEADING_DISTANCE } from "./steering";

/** Мёртвая зона вокруг желаемой дистанции — без неё стрелок дрожит на месте. */
const DEADZONE_UNITS = 24;
const PROJECTILE_TTL_SEC = 4;

const heading = createHeading();

/**
 * Держит дистанцию и стреляет. Даёт симуляции вторую популяцию снарядов —
 * для FPS-испытания это важно: вражеские снаряды нагружают пул и коллизии
 * иначе, чем сами враги.
 *
 * Касанием не бьёт: таймер атаки занят перезарядкой выстрела.
 */
export const kiteAndShoot: PatternBehavior = {
  update(world, index, dtSec) {
    const enemies = world.enemies;
    const typeIndex = enemies.type[index];
    const type = world.enemyTypes[typeIndex];
    const params = type.params;

    headingToPlayer(world, index, heading);
    if (heading.distance < MIN_HEADING_DISTANCE) return;

    const deadzone = DEADZONE_UNITS * world.config.unitScale;
    const speed = enemySpeed(world, index);
    if (heading.distance > params.preferredDistance + deadzone) {
      enemies.vx[index] = heading.nx * speed;
      enemies.vy[index] = heading.ny * speed;
    } else if (heading.distance < params.preferredDistance - deadzone) {
      enemies.vx[index] = -heading.nx * speed;
      enemies.vy[index] = -heading.ny * speed;
    } else {
      enemies.vx[index] = 0;
      enemies.vy[index] = 0;
    }

    enemies.attackCooldown[index] -= dtSec;
    if (enemies.attackCooldown[index] > 0) return;

    enemies.attackCooldown[index] = params.shotIntervalSec;
    const slot = spawnProjectile(
      world,
      enemies.x[index],
      enemies.y[index],
      heading.nx * params.projectileSpeed,
      heading.ny * params.projectileSpeed,
      // Урон берётся из слота, а не из типа: множитель сложности отрезка
      // застыл в нём в момент спавна (docs/26-stage2-plan.md, WP4.4).
      enemies.damage[index],
      PROJECTILE_TTL_SEC,
      false,
    );
    if (slot >= 0) world.projectiles.ownerType[slot] = typeIndex;
  },
};
