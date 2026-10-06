import { damageEnemy } from "../sim/combat";
import { MAX_PATTERN_RADIUS } from "../patterns";
import type { WeaponBehaviorImpl } from "./behavior";

/**
 * Постоянная зона урона вокруг игрока: бьёт всех в радиусе раз в
 * `cooldownSec`. Единственное оружие, которое не требует ни цели, ни
 * направления, — за это у него самый низкий урон за удар.
 */
export const aura: WeaponBehaviorImpl = {
  update(world, slot, level, dtSec) {
    const weapon = world.loadout.weapons[slot];
    if (weapon.cooldown > 0) weapon.cooldown -= dtSec;
    if (weapon.cooldown > 0) return;

    weapon.cooldown = level.cooldownSec;

    const player = world.player;
    const found = world.enemyGrid.queryInto(
      player.x,
      player.y,
      level.areaRadius + MAX_PATTERN_RADIUS * world.config.unitScale,
      world.queryBuffer,
    );

    for (let i = 0; i < found; i++) {
      const enemy = world.queryBuffer[i];
      if (world.enemies.alive[enemy] === 0) continue;

      const dx = world.enemies.x[enemy] - player.x;
      const dy = world.enemies.y[enemy] - player.y;
      const reach = level.areaRadius + world.enemyTypes[world.enemies.type[enemy]].radius;
      if (dx * dx + dy * dy > reach * reach) continue;

      damageEnemy(world, enemy, level.damage, slot, level.element, level.statusChance);
    }
  },
};
