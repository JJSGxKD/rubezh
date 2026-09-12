import { damageEnemy } from "../sim/combat";
import { pushSimEvent, SIM_EVENT } from "../sim/events";
import { MAX_PATTERN_RADIUS } from "../patterns";
import type { World } from "../sim/world";
import type { WeaponBehaviorImpl } from "./behavior";
import type { ResolvedWeaponLevel } from "./weapon-types";

/**
 * Удар по площади в случайного врага: бьёт там, где игрока нет, и потому
 * единственный дотягивается до стрелков, держащих дистанцию.
 *
 * Цель выбирается генератором мира — значит, забег воспроизводится; выбор
 * идёт одним проходом по живым врагам, без промежуточного списка.
 */
export const areaStrike: WeaponBehaviorImpl = {
  update(world, slot, level, dtSec) {
    const weapon = world.loadout.weapons[slot];
    if (weapon.cooldown > 0) weapon.cooldown -= dtSec;
    if (weapon.cooldown > 0) return;

    const strikes = Math.max(1, Math.round(level.projectiles));
    let struck = false;

    for (let i = 0; i < strikes; i++) {
      const target = pickRandomEnemy(world);
      if (target < 0) break;

      strikeAt(world, slot, level, world.enemies.x[target], world.enemies.y[target]);
      struck = true;
    }

    // Без целей перезарядка не тратится: иначе удар «пропадает» в момент,
    // когда врагов на экране нет, и возвращается уже в толпе.
    if (struck) weapon.cooldown = level.cooldownSec;
  },
};

/** Равновероятный выбор живого врага одним проходом (алгоритм резервуара). */
function pickRandomEnemy(world: World): number {
  const enemies = world.enemies;
  let chosen = -1;
  let seen = 0;

  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 0) continue;
    seen++;
    if (world.rng.nextFloat() * seen < 1) chosen = i;
  }
  return chosen;
}

function strikeAt(
  world: World,
  slot: number,
  level: ResolvedWeaponLevel,
  x: number,
  y: number,
): void {
  const found = world.enemyGrid.queryInto(
    x,
    y,
    level.areaRadius + MAX_PATTERN_RADIUS * world.config.unitScale,
    world.queryBuffer,
  );

  for (let i = 0; i < found; i++) {
    const enemy = world.queryBuffer[i];
    if (world.enemies.alive[enemy] === 0) continue;

    const dx = world.enemies.x[enemy] - x;
    const dy = world.enemies.y[enemy] - y;
    const reach = level.areaRadius + world.enemyTypes[world.enemies.type[enemy]].radius;
    if (dx * dx + dy * dy > reach * reach) continue;

    damageEnemy(world, enemy, level.damage, slot);
  }

  pushSimEvent(world.events, {
    kind: SIM_EVENT.strike,
    x,
    y,
    radius: level.areaRadius,
    tick: world.stats.tick,
  });
}
