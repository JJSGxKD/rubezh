/**
 * Набегающий счётчик награды (design/art/effects.md §6, F-07): число
 * досчитывается от прежнего значения к итоговому. Длительность — та же, что
 * у доливки полосы уровня: число и полоса растут вместе.
 */
export const COUNT_UP_MS = 700;

/**
 * Значение счётчика через `elapsedMs`: выход с торможением (кубический), так
 * что последние числа идут медленно и успевают прочитаться. Только целые, и
 * ровно итог в конце.
 */
export function countUpValue(from: number, to: number, elapsedMs: number): number {
  if (elapsedMs >= COUNT_UP_MS) return to;
  const t = Math.max(0, elapsedMs) / COUNT_UP_MS;
  const eased = 1 - (1 - t) * (1 - t) * (1 - t);
  return Math.round(from + (to - from) * eased);
}
