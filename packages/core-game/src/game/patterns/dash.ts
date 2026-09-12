import type { World } from "../sim/world";
import type { PatternBehavior } from "./behavior";
import { createHeading, headingToPlayer, MIN_HEADING_DISTANCE, stopEnemy } from "./steering";

/** Фазы рывка. Рендер читает их, чтобы показать телеграф. */
export const DASH_PHASE = {
  approach: 0,
  telegraph: 1,
  dash: 2,
  recover: 3,
} as const;

const heading = createHeading();

/**
 * Сближается, останавливается и мигает, затем делает рывок по прямой.
 *
 * Направление рывка **фиксируется в начале телеграфа**, а не в конце: иначе
 * от рывка нельзя уйти — враг довернул бы на игрока в последний момент.
 * Смысл паттерна в том, чтобы научить уклоняться вбок, пока враг мигает.
 */
export const dash: PatternBehavior = {
  update(world, index, dtSec) {
    const enemies = world.enemies;
    switch (enemies.phase[index]) {
      case DASH_PHASE.approach:
        approach(world, index);
        return;
      case DASH_PHASE.telegraph:
        stopEnemy(world, index);
        if (tickTimer(world, index, dtSec)) startDash(world, index);
        return;
      case DASH_PHASE.dash:
        if (tickTimer(world, index, dtSec)) startRecover(world, index);
        return;
      default:
        stopEnemy(world, index);
        if (tickTimer(world, index, dtSec)) enemies.phase[index] = DASH_PHASE.approach;
    }
  },
};

function approach(world: World, index: number): void {
  const enemies = world.enemies;
  const type = world.enemyTypes[enemies.type[index]];
  headingToPlayer(world, index, heading);

  const canTelegraph =
    heading.distance >= MIN_HEADING_DISTANCE && heading.distance <= type.params.triggerDistance;
  if (!canTelegraph) {
    enemies.vx[index] = heading.nx * type.speed;
    enemies.vy[index] = heading.ny * type.speed;
    return;
  }

  enemies.phase[index] = DASH_PHASE.telegraph;
  enemies.phaseTimer[index] = type.params.telegraphSec;
  enemies.dirX[index] = heading.nx;
  enemies.dirY[index] = heading.ny;
  stopEnemy(world, index);
}

function startDash(world: World, index: number): void {
  const enemies = world.enemies;
  const params = world.enemyTypes[enemies.type[index]].params;
  enemies.phase[index] = DASH_PHASE.dash;
  enemies.phaseTimer[index] = params.dashDurationSec;
  enemies.vx[index] = enemies.dirX[index] * params.dashSpeed;
  enemies.vy[index] = enemies.dirY[index] * params.dashSpeed;
}

function startRecover(world: World, index: number): void {
  const enemies = world.enemies;
  enemies.phase[index] = DASH_PHASE.recover;
  enemies.phaseTimer[index] = world.enemyTypes[enemies.type[index]].params.recoverSec;
  stopEnemy(world, index);
}

/** Уменьшить таймер фазы; `true` — фаза закончилась. */
function tickTimer(world: World, index: number, dtSec: number): boolean {
  world.enemies.phaseTimer[index] -= dtSec;
  return world.enemies.phaseTimer[index] <= 0;
}
