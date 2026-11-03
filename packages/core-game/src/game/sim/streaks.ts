import type { World } from "./world";

/**
 * Серии забега для достижений (docs/35-stage4-plan.md Р161, tasks/T-0321):
 * сколько тиков подряд игрок не получал попаданий и не убивал. Считается в
 * тиках по `world.stats.tick`, поэтому пауза и ожидание решения о втором
 * шансе серию не растят. Не трогает `world.rng` и порядок событий — эталоны
 * баланса от счёта не двигаются.
 *
 * Отдельным файлом без зависимостей от мира в рантайме: его зовут и
 * `world.ts`, и `player-status.ts`, которые уже зовут друг друга.
 */

/** Закрыть серию без попаданий: самая долгая закрытая запоминается, отсчёт идёт заново. */
export function registerPlayerHit(world: World): void {
  const stats = world.stats;
  const closed = stats.tick - stats.lastHitTick;
  if (closed > stats.longestNoHitTicks) stats.longestNoHitTicks = closed;
  stats.lastHitTick = stats.tick;
}

/** Закрыть серию без убийств убийством: игрок жив, раз убил снова. */
export function registerKill(world: World): void {
  const stats = world.stats;
  const closed = stats.tick - stats.lastKillTick;
  if (closed > stats.longestNoKillTicks) stats.longestNoKillTicks = closed;
  stats.lastKillTick = stats.tick;
}
