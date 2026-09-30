/**
 * Арифметика колеса удачи. Отдельно от разметки — чтобы проверять тестом, что
 * стрелка останавливается ровно на выпавшем секторе: колесо, показывающее
 * одно, а выдающее другое, для игрока выглядит как обман.
 *
 * Результат крутки и шансы присылает сервер, клиент только докручивает
 * колесо до выпавшего сектора (docs/07-monetization-and-ads.md §7).
 */

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
