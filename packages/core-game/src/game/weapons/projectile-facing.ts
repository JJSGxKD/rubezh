import type { WeaponBehaviorImpl } from "./behavior";
import { fireFan } from "./shooting";

/**
 * Снаряды в сторону движения. В отличие от наведения на ближайшего, требует
 * от игрока думать, куда он повёрнут, — и вознаграждает за проход сквозь
 * толпу пробиванием.
 *
 * Стреляет и на месте: направление взгляда сохраняется от последнего
 * движения, иначе остановка делала бы оружие бесполезным.
 */
export const projectileFacing: WeaponBehaviorImpl = {
  update(world, slot, level, dtSec) {
    const weapon = world.loadout.weapons[slot];
    if (weapon.cooldown > 0) weapon.cooldown -= dtSec;
    if (weapon.cooldown > 0) return;

    weapon.cooldown = level.cooldownSec;
    fireFan(world, slot, level, world.player.faceX, world.player.faceY);
  },
};
