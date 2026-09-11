import type { PatternBehavior } from "./behavior";
import { createHeading, moveStraightToPlayer } from "./steering";

const heading = createHeading();

/** Прямо на игрока на полной скорости — самый дешёвый и самый массовый. */
export const swarm: PatternBehavior = {
  update(world, index) {
    moveStraightToPlayer(world, index, heading);
  },
};
