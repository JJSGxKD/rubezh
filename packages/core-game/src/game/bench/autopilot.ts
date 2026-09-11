import type { SimInput } from "../sim/step";

/**
 * Скрипт движения для стресс-прогона: восемь секунд по кругу, две секунды
 * стоя. Автопилот, а не живой игрок, — сознательно: замер должен быть
 * сравним между устройствами и между сборками, а человек каждый раз играет
 * по-разному и портит сравнение.
 *
 * Паузы обязательны — автоатака работает только когда игрок стоит
 * (docs/02-roadmap.md, неделя 1), и без остановок прогон не задействует ни
 * снаряды, ни поиск ближайшей цели, то есть меряет не ту нагрузку.
 */
const CYCLE_TICKS = 600;
const MOVING_TICKS = 480;

export function benchInput(tick: number): SimInput {
  const cycle = tick % CYCLE_TICKS;
  if (cycle >= MOVING_TICKS) return { moveX: 0, moveY: 0 };

  const angle = (cycle / MOVING_TICKS) * Math.PI * 2;
  return { moveX: Math.cos(angle), moveY: Math.sin(angle) };
}
