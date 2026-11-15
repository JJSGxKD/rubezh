import { stalkerAlive } from "../sim/stalker-body";
import type { World } from "../sim/world";

/**
 * Радиус, в котором бот бежит от неубиваемого, единиц. Больше дистанции появления (150, T-0423):
 * бот реагирует сразу, а не когда преследователь уже рядом.
 */
export const STALKER_FLEE_UNITS = 240;

/**
 * Пишет в `out` единичное направление от живого преследователя и возвращает true, если тот ближе
 * `STALKER_FLEE_UNITS`. Бот видит только живого: предвестие появления он не замечает (Р205).
 * Преследователя узнают по признаку типа `unkillable`, а не по id. Только `Math.sqrt` — бот входит
 * в детерминированный прогон калибровки.
 */
export function stalkerFleeDirection(world: World, out: { x: number; y: number }): boolean {
  if (stalkerAlive(world) === 0) return false;
  const slot = world.stalkerBody.slot;
  if (!world.enemyTypes[world.enemies.type[slot]].unkillable) return false;

  const player = world.player;
  const dx = player.x - world.enemies.x[slot];
  const dy = player.y - world.enemies.y[slot];
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance > STALKER_FLEE_UNITS * world.config.unitScale) return false;
  if (distance < 1e-3) {
    // Вплотную направление не определено: любое, но одно и то же.
    out.x = 1;
    out.y = 0;
    return true;
  }
  out.x = dx / distance;
  out.y = dy / distance;
  return true;
}
