import type { PatternBehavior } from "./behavior";
import { createHeading, steerTowardPlayer } from "./steering";

const heading = createHeading();

/** Медленное, но настойчивое преследование с инерцией. */
export const chase: PatternBehavior = {
  update(world, index, dtSec) {
    steerTowardPlayer(world, index, dtSec, heading);
  },
};
