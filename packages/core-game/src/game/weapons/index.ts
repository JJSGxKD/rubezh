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
  element: 0,
  statusChance: 0,
};

/**
 * Числа уровня оружия в слоте с учётом пассивок — ровно те, которыми бьёт
 * симуляция. Её зовёт и рендер: считай он по базовому уровню, на экране было
 * бы меньше оберегов и уже кольцо, чем на самом деле. Пишет в `out` и
 * возвращает его: выделять объект на кадр нельзя.
 */
export function effectiveWeaponLevel(world: World, slot: number, out: ResolvedWeaponLevel): ResolvedWeaponLevel {
  const stats = world.playerStats;
  const weapon = world.loadout.weapons[slot];
  const type = world.weaponTypes[weapon.typeIndex];
  const level = type.levels[Math.min(weapon.level, type.levels.length) - 1];

  out.damage = level.damage * stats.damageMul;
  out.cooldownSec = level.cooldownSec * stats.cooldownMul;
  out.areaRadius = level.areaRadius * stats.areaMul;
  out.projectileSpeed = level.projectileSpeed * stats.projectileSpeedMul;
  out.ttlSec = level.ttlSec * stats.durationMul;
  out.pierce = level.pierce;
  out.element = level.element;
  out.statusChance = level.statusChance;
  // Аура бьёт зоной, снарядов у неё нет — прибавка от пассивки на число
  // снарядов ей ничего не даёт и не должна раздувать её зону ударов.
  out.projectiles = type.behavior === "aura" ? level.projectiles : level.projectiles + stats.extraProjectiles;
  return out;
}

/**
 * Обновить всё оружие игрока. Пассивки применяются здесь, а не внутри
 * поведений: поведение знает только свои числа на этот тик и ничего не знает
 * ни про уровни, ни про улучшения.
 */
export function updateWeapons(world: World, dtSec: number): void {
  if (!world.player.alive) return;

  for (let slot = 0; slot < world.loadout.weapons.length; slot++) {
    const type = world.weaponTypes[world.loadout.weapons[slot].typeIndex];
    WEAPON_BEHAVIORS[type.behavior].update(world, slot, effectiveWeaponLevel(world, slot, effective), dtSec);
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
