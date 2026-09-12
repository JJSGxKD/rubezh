import { vectorLength } from "../sim/vector";
import type { WeaponBehaviorImpl } from "./behavior";
import { fireFan, findNearestEnemy } from "./shooting";

/**
 * Снаряд в ближайшего врага — атака, с которой начинался прототип. Работает и
 * на бегу: стрельба только на остановке читалась как наказание за движение.
 *
 * Перезарядка не запускается, пока цели нет: иначе оружие «стреляет» в пустоту
 * и к появлению врага оказывается на перезарядке.
 */
export const projectileNearest: WeaponBehaviorImpl = {
  update(world, slot, level, dtSec) {
    const weapon = world.loadout.weapons[slot];
    if (weapon.cooldown > 0) weapon.cooldown -= dtSec;
    if (weapon.cooldown > 0) return;

    const player = world.player;
    const target = findNearestEnemy(world, player.x, player.y, world.config.player.attackRangePx);
    if (target < 0) return;

    const dx = world.enemies.x[target] - player.x;
    const dy = world.enemies.y[target] - player.y;
    const distance = vectorLength(dx, dy);
    if (distance < 1e-3) return;

    weapon.cooldown = level.cooldownSec;
    fireFan(world, slot, level, dx / distance, dy / distance);
  },
};
