import { spawnProjectile, type World } from "../sim/world";
import { vectorLength } from "../sim/vector";
import type { ResolvedWeaponLevel } from "./weapon-types";

/**
 * Разброс веера снарядов: смещение по перпендикуляру на каждый шаг от центра.
 * Веер строится сложением векторов, а не поворотом на угол, — тригонометрия
 * в симуляции запрещена (docs/26-stage2-plan.md, WP4.5).
 */
const SPREAD_STEP = 0.18;

/**
 * Смещение снаряда с номером `index` в веере: 0, +1, −1, +2, −2 и так далее.
 *
 * Центр занят **всегда**. Прежняя раскладка расставляла снаряды симметрично
 * вокруг центра, и при чётном их числе прямо вперёд не летело ничего: игрок
 * бежал на врага, а нож расходился мимо него в обе стороны. Чётное число
 * приходит не только из контента — его добавляет пассивка «Залп», поэтому
 * чинить это в числах оружия бессмысленно.
 *
 * Цена — лёгкая асимметрия при чётном числе снарядов. Она незаметна, а
 * попадание туда, куда смотришь, заметно очень.
 */
function fanOffset(index: number): number {
  const step = Math.ceil(index / 2);
  return index % 2 === 0 ? -step : step;
}

/**
 * Выпустить веер снарядов из позиции игрока в заданном направлении.
 * Направление должно быть единичным.
 */
export function fireFan(
  world: World,
  slot: number,
  level: ResolvedWeaponLevel,
  dirX: number,
  dirY: number,
): void {
  const player = world.player;
  const count = Math.max(1, Math.round(level.projectiles));

  for (let i = 0; i < count; i++) {
    const offset = fanOffset(i) * SPREAD_STEP;
    const spreadX = dirX - dirY * offset;
    const spreadY = dirY + dirX * offset;
    const length = vectorLength(spreadX, spreadY);
    if (length < 1e-6) continue;

    const projectile = spawnProjectile(
      world,
      player.x,
      player.y,
      (spreadX / length) * level.projectileSpeed,
      (spreadY / length) * level.projectileSpeed,
      level.damage,
      level.ttlSec,
      true,
    );
    if (projectile < 0) return;

    world.projectiles.ownerWeapon[projectile] = slot;
    world.projectiles.pierce[projectile] = Math.min(255, Math.round(level.pierce));
    world.projectiles.element[projectile] = level.element;
    world.projectiles.statusChance[projectile] = level.statusChance;
    world.stats.shotsFired++;
  }
}

/** Ближайший живой враг в радиусе или -1. */
export function findNearestEnemy(world: World, x: number, y: number, radius: number): number {
  const found = world.enemyGrid.queryInto(x, y, radius, world.queryBuffer);
  const enemies = world.enemies;

  let best = -1;
  let bestDistanceSq = radius * radius;
  for (let k = 0; k < found; k++) {
    const i = world.queryBuffer[k];
    if (enemies.alive[i] === 0) continue;
    const dx = enemies.x[i] - x;
    const dy = enemies.y[i] - y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = i;
    }
  }
  return best;
}
