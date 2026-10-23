import { vectorLength } from "../sim/vector";
import type { PatternBehavior } from "./behavior";
import { enemySpeed, stopEnemy } from "./steering";

/** Фаза стража: идёт к месту или стоит на нём. */
export const CORDON_PHASE = { arriving: 0, holding: 1 } as const;

/** Ближе этого к месту страж считается стоящим в строю. */
const HOLD_DISTANCE_UNITS = 4;

/**
 * Страж кольца: держит своё место в строю (Р112). Место — центр кольца плюс
 * направление страж · текущий радиус; страж идёт к нему на своей скорости,
 * встаёт и дальше следует за сжатием. Быстрее своей скорости он не движется,
 * поэтому строй можно только пробить, а не обойти. Игрока он не преследует:
 * куда бы тот ни шёл, страж остаётся на месте.
 */
export const cordon: PatternBehavior = {
  update(world, index, dtSec) {
    const state = world.cordon;
    // Страховка для снимка: страж без кольца (кольцо кончилось, страж ещё жив) не бродит.
    if (!state.active) {
      stopEnemy(world, index);
      return;
    }

    const enemies = world.enemies;
    const placeX = state.centerX + enemies.dirX[index] * state.radius;
    const placeY = state.centerY + enemies.dirY[index] * state.radius;
    const dx = placeX - enemies.x[index];
    const dy = placeY - enemies.y[index];
    const distance = vectorLength(dx, dy);

    enemies.phase[index] = distance <= HOLD_DISTANCE_UNITS * world.config.unitScale ? CORDON_PHASE.holding : CORDON_PHASE.arriving;
    if (distance < 1e-6) {
      stopEnemy(world, index);
      return;
    }

    // Шаг не длиннее остатка пути: страж встаёт на место, а не колеблется вокруг него.
    const speed = Math.min(enemySpeed(world, index), distance / dtSec);
    enemies.vx[index] = (dx / distance) * speed;
    enemies.vy[index] = (dy / distance) * speed;
  },
};
