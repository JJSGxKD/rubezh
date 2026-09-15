import type { SimInput } from "./step";

/**
 * Квантованное направление ввода (docs/28-diagnostics.md §3.4).
 *
 * Симуляция получает не сырой наклон джойстика, а одно из 256 направлений
 * или покой — и в живом забеге, и при повторе. Иначе в лог ввода пишется
 * округлённое значение, а симуляция шагала бы по неокруглённому, и повтор
 * разошёлся бы с оригиналом на первых секундах.
 *
 * Направления — целые точки на периметре квадрата со стороной 64: по 64 на
 * сторону, ровно 256 на оборот. Не угол, а точки квадрата — потому что угол
 * требует `atan2` и `cos`, а они расходятся между JS-движками
 * (docs/26-stage2-plan.md, WP4.5). Симуляция всё равно нормирует направление
 * через `Math.sqrt`, а он точный. Шаг по углу неравномерный — от 0.9° у углов
 * квадрата до 1.8° в середине стороны, — на глаз и под пальцем это неотличимо.
 *
 * Клавиатура попадает в точки без округления: (1, 0) — середина стороны,
 * (1, 1) — угол.
 */

/** Сколько направлений на оборот. */
export const DIRECTION_CODES = 256;
/** Покой — палец не на экране или в мёртвой зоне. */
export const IDLE_CODE = -1;

const HALF_SIDE = 32;
const PER_SIDE = DIRECTION_CODES / 4;

/**
 * Запас гистерезиса в долях шага. Без него палец на границе двух направлений
 * переключал бы код каждый кадр: персонаж этого не заметит, а лог ввода
 * раздуется, потому что серии одинаковых значений перестанут сворачиваться.
 */
const HYSTERESIS = 0.25;

/**
 * Код направления для сырого вектора. `previous` — код прошлого кадра: пока
 * новое направление ближе к нему, чем полшага с запасом, код не меняется.
 */
export function quantizeDirection(dx: number, dy: number, previous: number): number {
  const scale = Math.max(Math.abs(dx), Math.abs(dy));
  if (!(scale > 0) || !Number.isFinite(scale)) return IDLE_CODE;

  const position = perimeterPosition((dx * HALF_SIDE) / scale, (dy * HALF_SIDE) / scale);
  if (previous >= 0 && previous < DIRECTION_CODES) {
    const distance = Math.abs(position - previous);
    if (Math.min(distance, DIRECTION_CODES - distance) <= 0.5 + HYSTERESIS) return previous;
  }
  return Math.round(position) % DIRECTION_CODES;
}

/** Ввод симуляции для кода. Пишет в переданный объект: в кадре новых объектов нет. */
export function inputOfCode(code: number, out: SimInput): SimInput {
  if (code < 0 || code >= DIRECTION_CODES) {
    out.moveX = 0;
    out.moveY = 0;
    return out;
  }
  const offset = code % PER_SIDE;
  switch ((code - offset) / PER_SIDE) {
    case 0:
      out.moveX = HALF_SIDE;
      out.moveY = offset - HALF_SIDE;
      break;
    case 1:
      out.moveX = HALF_SIDE - offset;
      out.moveY = HALF_SIDE;
      break;
    case 2:
      out.moveX = -HALF_SIDE;
      out.moveY = HALF_SIDE - offset;
      break;
    default:
      out.moveX = offset - HALF_SIDE;
      out.moveY = -HALF_SIDE;
  }
  return out;
}

/**
 * Положение точки периметра в кодах, непрерывно от 0 до 256. Одна координата
 * точки ровно ±32: делитель — большая по модулю координата, а умножение на
 * степень двойки и деление на само число в IEEE 754 точные.
 */
function perimeterPosition(x: number, y: number): number {
  let position: number;
  if (x === HALF_SIDE && y < HALF_SIDE) position = y + HALF_SIDE;
  else if (y === HALF_SIDE && x > -HALF_SIDE) position = PER_SIDE + HALF_SIDE - x;
  else if (x === -HALF_SIDE && y > -HALF_SIDE) position = 2 * PER_SIDE + HALF_SIDE - y;
  else position = 3 * PER_SIDE + x + HALF_SIDE;
  return position >= DIRECTION_CODES ? position - DIRECTION_CODES : position;
}
