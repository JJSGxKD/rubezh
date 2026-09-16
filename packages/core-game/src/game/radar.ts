import { RADAR_BLIP, type RadarSnapshot } from "../run-api";
import { isElite } from "./patterns";
import { PICKUP_KIND } from "./sim/pickups";
import type { World } from "./sim/world";

/**
 * Снимок радара для HUD (docs/27-design-system-and-app-shell.md §3.2).
 *
 * Считается раз в снимок HUD, то есть не чаще 10 раз в секунду, и только из
 * состояния мира: оболочка мир не читает, она получает готовые точки.
 *
 * Радиус радара — кольцо спавна: там появляются враги, которых игрок ещё не
 * видит, и именно о них радар должен предупредить. Точек не больше
 * `MAX_BLIPS`: элиты и подборы кладутся первыми — рядовой рой можно показать
 * не весь, а босса за краем экрана пропустить нельзя.
 */
export const MAX_BLIPS = 96;

const BLIP_BY_PICKUP: Record<number, number> = {
  [PICKUP_KIND.medkit]: RADAR_BLIP.medkit,
  [PICKUP_KIND.magnet]: RADAR_BLIP.magnet,
  [PICKUP_KIND.dynamite]: RADAR_BLIP.dynamite,
};

export function buildRadarSnapshot(world: World): RadarSnapshot {
  const blips = new Float32Array(MAX_BLIPS * 3);
  const range = world.config.view.spawnRadius;
  const player = world.player;
  let count = 0;

  const push = (x: number, y: number, kind: number): void => {
    if (count >= MAX_BLIPS) return;
    let nx = (x - player.x) / range;
    let ny = (y - player.y) / range;
    const lengthSq = nx * nx + ny * ny;
    if (lengthSq > 1) {
      // Дальше радиуса — к краю: направление угрозы важнее её расстояния.
      const length = Math.sqrt(lengthSq);
      nx /= length;
      ny /= length;
    }
    blips[count * 3] = nx;
    blips[count * 3 + 1] = ny;
    blips[count * 3 + 2] = kind;
    count++;
  };

  const pickups = world.pickups;
  for (let i = 0; i < pickups.count; i++) {
    if (pickups.alive[i] === 1) push(pickups.x[i], pickups.y[i], BLIP_BY_PICKUP[pickups.kind[i]] ?? RADAR_BLIP.medkit);
  }

  const enemies = world.enemies;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 1 && isElite(world.enemyTypes[enemies.type[i]])) {
      push(enemies.x[i], enemies.y[i], RADAR_BLIP.elite);
    }
  }
  for (let i = 0; i < enemies.count && count < MAX_BLIPS; i++) {
    if (enemies.alive[i] === 1 && !isElite(world.enemyTypes[enemies.type[i]])) {
      push(enemies.x[i], enemies.y[i], RADAR_BLIP.enemy);
    }
  }

  return { blips, count };
}
