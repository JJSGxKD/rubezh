/**
 * Шкалы графиков в карточках отчётов: круглые верхние границы, по которым
 * подписи сетки читаются без калькулятора.
 */

/** Верх шкалы FPS — ближайшая частота экрана сверху: 60, 90, 120… */
export function niceFpsMax(value: number): number {
  for (const candidate of [30, 60, 90, 120, 144, 165, 240]) if (value <= candidate) return candidate;
  return Math.ceil(value / 60) * 60;
}

/** Круглая граница сверху: 1, 2, 2.5, 5 на порядок. */
export function niceCeil(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * magnitude) return step * magnitude;
  return 10 * magnitude;
}

/** Координаты SVG с одним знаком: короче разметка, глазу разницы нет. */
export function round(value: number): number {
  return Math.round(value * 10) / 10;
}
