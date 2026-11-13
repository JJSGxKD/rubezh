import type { PatternBehavior } from "./behavior";
import { createHeading, headingToPlayer, stopEnemy } from "./steering";

const heading = createHeading();

/**
 * Неубиваемый преследователь (Р205): идёт прямо на игрока, пока не коснулся, а после касания стоит
 * `recoverSec`. Скорость — из контента как есть: ступень, подстройка и состояния его не меняют, поэтому
 * здесь не `enemySpeed`, который читает множитель ступени. Таймеры тела тикают в `sim/stalker-body.ts`.
 */
export const stalker: PatternBehavior = {
  update(world, index) {
    if (world.stalkerBody.recoverTicks > 0) {
      stopEnemy(world, index);
      return;
    }
    const speed = world.enemyTypes[world.enemies.type[index]].speed;
    headingToPlayer(world, index, heading);
    world.enemies.vx[index] = heading.nx * speed;
    world.enemies.vy[index] = heading.ny * speed;
  },
};
