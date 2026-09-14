import type { RunInspection } from "../../run-api";
import type { World } from "../sim/world";

/**
 * Характеристики забега для листа «Характеристики» (docs/27-design-system-and-app-shell.md §6).
 *
 * Числа оружия считаются так же, как `updateWeapons`: уровень из контента,
 * умноженный на пассивки. Иначе лист показывал бы «урон 12», а оружие било
 * бы на 15 — и игрок перестал бы верить экрану.
 */
export function inspectWorld(world: World): RunInspection {
  const scale = world.config.unitScale;
  const stats = world.playerStats;
  const elapsed = world.stats.elapsedSec;
  const totalDamage = world.stats.damageDealt;

  return {
    survivalSec: elapsed,
    level: world.progression.level,
    enemiesKilled: world.stats.enemiesKilled,
    damageTaken: world.stats.damageTaken,
    player: {
      hp: world.player.hp,
      maxHp: world.player.maxHp,
      regenPerSec: stats.regenPerSec,
      armor: stats.armor,
      moveSpeed: (world.config.player.speedPxSec * stats.moveSpeedMul) / scale,
      pickupRadius: stats.pickupRadius / scale,
      damageMul: stats.damageMul,
      cooldownMul: stats.cooldownMul,
      areaMul: stats.areaMul,
      projectileSpeedMul: stats.projectileSpeedMul,
      extraProjectiles: stats.extraProjectiles,
    },
    weapons: world.loadout.weapons.map((slot, index) => {
      const type = world.weaponTypes[slot.typeIndex];
      const level = type.levels[Math.min(slot.level, type.levels.length) - 1];
      const dealt = world.stats.damageByWeapon[index] ?? 0;
      return {
        id: type.id,
        behavior: type.behavior,
        level: slot.level,
        maxLevel: type.levels.length,
        damage: level.damage * stats.damageMul,
        cooldownSec: level.cooldownSec * stats.cooldownMul,
        projectiles: type.behavior === "aura" ? level.projectiles : level.projectiles + stats.extraProjectiles,
        pierce: level.pierce,
        areaRadius: (level.areaRadius * stats.areaMul) / scale,
        damageDealt: dealt,
        damageShare: totalDamage > 0 ? dealt / totalDamage : 0,
        dps: elapsed > 0 ? dealt / elapsed : 0,
      };
    }),
    passives: world.loadout.passives.map((slot) => {
      const type = world.passiveTypes[slot.typeIndex];
      return {
        id: type.id,
        category: type.category,
        level: slot.level,
        maxLevel: type.levels.length,
        stat: type.stat,
        op: type.op,
        value: type.levels[Math.min(slot.level, type.levels.length) - 1],
      };
    }),
  };
}
