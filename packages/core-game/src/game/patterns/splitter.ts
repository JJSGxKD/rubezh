import { spawnEnemy } from "../sim/world";
import { vectorLength } from "../sim/vector";
import type { PatternBehavior } from "./behavior";
import { createHeading, steerTowardPlayer } from "./steering";

/** Насколько далеко от родителя появляются потомки. */
const SPREAD_UNITS = 14;

const heading = createHeading();

/**
 * Преследует с инерцией, при смерти распадается на врагов других типов —
 * наказывает урон без позиции: убил в толпе — получил толпу побольше.
 *
 * Потомок сам может быть делящимся: так собирается матрёшка, у которой
 * каждая ступень — свой бой. Что цепочка кончается, проверяет контент.
 */
export const splitter: PatternBehavior = {
  update(world, index, dtSec) {
    steerTowardPlayer(world, index, dtSec, heading);
  },

  onDeath(world, index) {
    const params = world.enemyTypes[world.enemies.type[index]].params;
    if (params.children.length === 0) return;

    // Позиция читается до спавна: первый потомок может занять освобождённый
    // слот родителя и перезаписать её (контракт onDeath в behavior.ts).
    const originX = world.enemies.x[index];
    const originY = world.enemies.y[index];
    const spread = SPREAD_UNITS * world.config.unitScale;

    // Потомки выходят вперемешку по видам, а не кучками: матрёшка рассыпается
    // смесью, и по первому выпавшему нельзя угадать, кто там ещё внутри.
    // Круг за кругом по видам, пока у каждого не кончится своё число.
    for (let round = 0; ; round++) {
      let placed = false;
      for (const kind of params.children) {
        if (kind.count <= round) continue;
        placed = true;

        // Смещение — случайный вектор, нормированный через sqrt, а не угол
        // через cos/sin: тригонометрия расходится между JS-движками.
        let offsetX = world.rng.nextRange(-1, 1);
        let offsetY = world.rng.nextRange(-1, 1);
        const length = vectorLength(offsetX, offsetY);
        if (length < 1e-3) {
          offsetX = 1;
          offsetY = 0;
        } else {
          offsetX /= length;
          offsetY /= length;
        }

        const slot = spawnEnemy(
          world,
          kind.typeIndex,
          originX + offsetX * spread,
          originY + offsetY * spread,
        );
        // Пул исчерпан — остальные потомки не появятся. Это детерминированно и
        // не ломает забег, в отличие от попытки расширить пул на ходу.
        if (slot < 0) return;
      }
      if (!placed) return;
    }
  },
};
