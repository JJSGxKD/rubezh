/**
 * Арифметика колеса удачи. Отдельно от разметки — чтобы проверять тестом, что
 * стрелка останавливается ровно на выпавшем секторе: колесо, показывающее
 * одно, а выдающее другое, для игрока выглядит как обман.
 *
 * Результат крутки в настоящем колесе выбирает сервер, клиент только
 * докручивает до него (docs/07-monetization-and-ads.md §7). Поэтому выбор
 * сектора и поворот — две разные функции.
 */

/** Сектор по броску `roll` из [0, 1): вероятность пропорциональна весу. */
export function pickSector(weights: readonly number[], roll: number): number {
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (total <= 0) return 0;

  let threshold = Math.min(Math.max(roll, 0), 1) * total;
  // roll = 1 или накопленная ошибка округления проходят цикл насквозь —
  // тогда выпадает последний сектор с весом.
  let lastWeighted = 0;
  for (let index = 0; index < weights.length; index += 1) {
    const weight = Math.max(0, weights[index] ?? 0);
    if (weight <= 0) continue;
    if (threshold < weight) return index;
    threshold -= weight;
    lastWeighted = index;
  }
  return lastWeighted;
}

/** Шансы в процентах для таблицы на экране. */
export function sectorOdds(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  return weights.map((weight) => (total <= 0 ? 0 : (Math.max(0, weight) / total) * 100));
}

/** Угол середины сектора от верха по часовой стрелке, в градусах. */
export function sectorCenterDeg(index: number, count: number): number {
  return ((index + 0.5) * 360) / count;
}

/**
 * Итоговый поворот колеса, при котором середина сектора `index` окажется под
 * стрелкой сверху. Поворот только растёт — колесо всегда крутится вперёд — и
 * делает не меньше `turns` полных оборотов, иначе крутка выглядит как рывок.
 */
export function spinRotationDeg(
  currentDeg: number,
  index: number,
  count: number,
  turns: number,
): number {
  const target = mod(-sectorCenterDeg(index, count), 360);
  const base = currentDeg + turns * 360;
  return base + mod(target - base, 360);
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
