import type { World } from "../sim/world";
import { effectiveWeaponLevel, orbiterCount, orbiterPosition, type OrbiterPoint, type ResolvedWeaponLevel } from "../weapons";

/**
 * Где рисовать обереги в этом кадре. Без Phaser: чистая логика, которую
 * покрывают тесты (test/orbiter-points.test.ts).
 *
 * Числа берутся «как в симуляции» (`effectiveWeaponLevel`), а центр — сглаженная
 * позиция героя: героя рисуют между тиками, и обереги от несглаженной позиции
 * прыгают относительно него на каждом кадре.
 */

/** Буфер усиленного уровня: переиспользуется, на кадр память не выделяется. */
const level: ResolvedWeaponLevel = {
  damage: 0,
  cooldownSec: 0,
  projectiles: 1,
  pierce: 0,
  areaRadius: 0,
  projectileSpeed: 0,
  ttlSec: 0,
  element: 0,
  statusChance: 0,
};

/**
 * Пишет точки оберегов в `out` и возвращает их число. Объекты точек
 * переиспользуются, массив растёт только при нехватке.
 */
export function orbiterRenderPoints(world: World, t: number, out: OrbiterPoint[]): number {
  const player = world.player;
  const centerX = player.prevX + (player.x - player.prevX) * t;
  const centerY = player.prevY + (player.y - player.prevY) * t;
  let drawn = 0;

  for (let slot = 0; slot < world.loadout.weapons.length; slot++) {
    const type = world.weaponTypes[world.loadout.weapons[slot].typeIndex];
    if (type.behavior !== "orbit") continue;

    effectiveWeaponLevel(world, slot, level);
    const count = orbiterCount(level);
    for (let k = 0; k < count; k++) {
      if (out.length <= drawn) out.push({ x: 0, y: 0 });
      orbiterPosition(world, slot, level, k, out[drawn], centerX, centerY);
      drawn += 1;
    }
  }
  return drawn;
}
