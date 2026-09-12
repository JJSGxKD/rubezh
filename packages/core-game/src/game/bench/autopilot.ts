import { createDirection, ringDirection } from "../sim/directions";
import type { SimInput } from "../sim/step";

/**
 * Скрипт движения для стресс-прогона: восемь секунд по кругу, две секунды
 * стоя. Автопилот, а не живой игрок, — сознательно: замер должен быть
 * сравним между устройствами и между сборками, а человек каждый раз играет
 * по-разному и портит сравнение.
 *
 * Паузы обязательны — на остановке камера приближается, а оружие, которое
 * бьёт по направлению взгляда, работает иначе; без остановок прогон меряет не
 * ту нагрузку.
 *
 * Направление берётся из таблицы готовых векторов, а не считается через
 * `Math.cos`: тригонометрия приближённая и расходится между JS-движками, а от
 * скрипта ввода зависит исход прогона — и эталонного забега тоже
 * (docs/26-stage2-plan.md, WP4.5).
 */
const CYCLE_TICKS = 600;
const MOVING_TICKS = 480;

const direction = createDirection();

export function benchInput(tick: number): SimInput {
  const cycle = tick % CYCLE_TICKS;
  if (cycle >= MOVING_TICKS) return { moveX: 0, moveY: 0 };

  ringDirection(0, cycle, MOVING_TICKS, direction);
  return { moveX: direction.x, moveY: direction.y };
}
