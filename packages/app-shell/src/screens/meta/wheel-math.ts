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
 * Перевернуть ли подпись сектора. Подпись поворачивается вместе с сектором,
 * и в нижней половине колеса без переворота «150» читается как «051». Ровно
 * сбоку — без переворота: там текст стоит боком в обе стороны одинаково.
 */
export function labelUpsideDown(centerDeg: number): boolean {
  const deg = mod(centerDeg, 360);
  return deg > 90 && deg < 270;
}

/**
 * Перевернуть ли подпись сектора при повороте колеса `rotationDeg`. Колесо
 * после крутки стоит повёрнутым, и переворот по положению в покое ставил
 * выигрыш под стрелкой вверх ногами. Поворот — итоговый: подписи встают как
 * надо к медленному концу крутки, а в быстром начале их не разглядеть.
 */
export function sectorLabelUpsideDown(index: number, count: number, rotationDeg: number): boolean {
  return labelUpsideDown(sectorCenterDeg(index, count) + rotationDeg);
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
