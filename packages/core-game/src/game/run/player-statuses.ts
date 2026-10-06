import type { PlayerStatusSnapshot } from "../../run-api";
import type { World } from "../sim/world";

/**
 * Состояния игрока для HUD — в том же порядке важности, что тон персонажа на
 * канве: шок, горение, яд, холод. Снимок собирается десять раз в секунду, и
 * у чистого игрока это пустой массив без лишних объектов.
 */
export function buildPlayerStatuses(world: World): PlayerStatusSnapshot[] {
  const player = world.player;
  const statuses: PlayerStatusSnapshot[] = [];
  if (player.shockTimer > 0) statuses.push({ element: "lightning", sec: player.shockTimer, stacks: 1 });
  if (player.burnTimer > 0) statuses.push({ element: "fire", sec: player.burnTimer, stacks: 1 });
  if (player.poisonTimer > 0) statuses.push({ element: "poison", sec: player.poisonTimer, stacks: player.poisonStacks });
  if (player.chillTimer > 0) statuses.push({ element: "cold", sec: player.chillTimer, stacks: 1 });
  return statuses;
}
