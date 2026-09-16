import type { WeaponBehavior } from "@bh/shared-types";
import type { World } from "../sim/world";
import type { WeaponBehaviorImpl } from "./behavior";
import { areaStrike } from "./area-strike";
import { aura } from "./aura";
import { orbit } from "./orbit";
import { projectileFacing } from "./projectile-facing";
import { projectileNearest } from "./projectile-nearest";
import type { ResolvedWeaponLevel } from "./weapon-types";

/**
 * Реестр поведений оружия. Новое поведение — код участника 1; новое оружие на
 * готовом поведении и все числа — данные геймдизайнера
 * (docs/01-tech-stack.md §9).
 */
export const WEAPON_BEHAVIORS: Record<WeaponBehavior, WeaponBehaviorImpl> = {
  projectile_nearest: projectileNearest,
  projectile_facing: projectileFacing,
  orbit,
  aura,
  area_strike: areaStrike,
};

export const IMPLEMENTED_WEAPON_BEHAVIORS = Object.keys(WEAPON_BEHAVIORS) as WeaponBehavior[];

/**
 * Числа уровня с учётом пассивок. Объект переиспользуется: пересоздавать его
 * на каждое оружие каждый тик — мусор в горячем цикле.
 */
const effective: ResolvedWeaponLevel = {
  damage: 0,
  cooldownSec: 0,
  projectiles: 1,
  pierce: 0,
  areaRadius: 0,
  projectileSpeed: 0,
  ttlSec: 0,
};

/**
 * Обновить всё оружие игрока. Пассивки применяются здесь, а не внутри
 * поведений: поведение знает только свои числа на этот тик и ничего не знает
 * ни про уровни, ни про улучшения.
 */
export function updateWeapons(world: World, dtSec: number): void {
  if (!world.player.alive) return;
  const stats = world.playerStats;

  for (let slot = 0; slot < world.loadout.weapons.length; slot++) {
    const weapon = world.loadout.weapons[slot];
    const type = world.weaponTypes[weapon.typeIndex];
    const level = type.levels[Math.min(weapon.level, type.levels.length) - 1];

    effective.damage = level.damage * stats.damageMul;
    effective.cooldownSec = level.cooldownSec * stats.cooldownMul;
    effective.areaRadius = level.areaRadius * stats.areaMul;
    effective.projectileSpeed = level.projectileSpeed * stats.projectileSpeedMul;
    effective.ttlSec = level.ttlSec * stats.durationMul;
    effective.pierce = level.pierce;
    // Аура бьёт зоной, снарядов у неё нет — прибавка от пассивки на число
    // снарядов ей ничего не даёт и не должна раздувать её зону ударов.
    effective.projectiles =
      type.behavior === "aura" ? level.projectiles : level.projectiles + stats.extraProjectiles;

    WEAPON_BEHAVIORS[type.behavior].update(world, slot, effective, dtSec);
  }
}

export type { WeaponBehaviorImpl } from "./behavior";
export {
  findWeaponContentProblems,
  resolveWeaponTypes,
  type ResolvedWeaponLevel,
  type WeaponType,
} from "./weapon-types";
export { MAX_ORBITERS, ORBITER_RADIUS, orbiterCount, orbiterPosition, type OrbiterPoint } from "./orbit";
