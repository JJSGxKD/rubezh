import { TICK_SEC, type World } from "./world";

/**
 * Заморозка подбором (docs/35-stage4-plan.md, Р105): общий таймер мира,
 * пока он идёт, живые враги не ходят, не бьют и не ведут таймеры паттернов.
 *
 * Это не холод одного врага (`elements.ts`) и не чит разработчика
 * (`cheats.freezeEnemies`): третий, общий механизм. Таймер лежит в `stats`
 * мира, потому что снимок забега переносит всё поле целиком — отдельного
 * места в формате снимка не нужно.
 */

/** Потолок срока из контента: дольше полминуты передышка перестаёт быть передышкой. */
export const MAX_FREEZE_SEC = 30;

/** Подобрана заморозка: таймер — на полный срок, а не суммой с остатком. */
export function startFreeze(world: World): void {
  const total = Math.round(world.drops.freeze.durationSec / TICK_SEC);
  world.stats.freezeTotalTicks = total;
  world.stats.freezeTicks = total;
}

/** Таймер тикает вместе с миром: пауза и выбор улучшения его не съедают. */
export function tickFreeze(world: World): void {
  if (world.stats.freezeTicks > 0) world.stats.freezeTicks--;
}

/** Второй шанс обнуляет заморозку: враги убраны, а оставшаяся передышка не нужна. */
export function clearFreeze(world: World): void {
  world.stats.freezeTicks = 0;
  world.stats.freezeTotalTicks = 0;
}

/**
 * Стоит ли враг сейчас. Босс стоит только часть срока — в начале: целый срок
 * превратил бы контрольную точку сложности в мишень.
 */
export function isTimeFrozen(world: World, boss: boolean): boolean {
  const left = world.stats.freezeTicks;
  if (left <= 0) return false;
  if (!boss) return true;
  const total = world.stats.freezeTotalTicks;
  return total - left < Math.floor(total * world.drops.freeze.bossDurationRatio);
}
