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

/** Длительность крутки, мс, — та же, что `--duration-spin` в tokens.css. */
export const SPIN_DURATION_MS = 4200;
/** Кривая замедления крутки — та же, что `--ease-spin` в tokens.css. */
export const SPIN_EASE = [0.12, 0.62, 0.08, 1] as const;
/** Чаще этого щелчки не звучат: на быстром начале они слились бы в гул. */
export const TICK_MIN_GAP_MS = 45;
/** Щелчок реже этого — медленный конец крутки: к нему добавляется вибрация. */
export const TICK_SLOW_GAP_MS = 140;

export interface SpinTick {
  /** от начала крутки */
  atMs: number;
  /** медленный конец: щелчки редкие, у каждого — вибрация */
  slow: boolean;
}

/**
 * Щелчки трещотки (design/art/direction-v2.md §7.6): момент, когда граница
 * сектора проходит под стрелкой. Стрелка стоит на середине сектора при
 * повороте, кратном шагу сектора со сдвигом в полшага, значит на границе —
 * при повороте, кратном шагу. Время — обратная кривая замедления: колесо на
 * экране и щелчки идут в такт, и последние щелчки редеют вместе с колесом.
 */
export function spinTicks(fromDeg: number, toDeg: number, count: number, durationMs = SPIN_DURATION_MS): SpinTick[] {
  if (count <= 0 || toDeg <= fromDeg) return [];
  const step = 360 / count;
  const ticks: SpinTick[] = [];
  let last = -Infinity;
  for (let m = Math.floor(fromDeg / step) + 1; m * step < toDeg; m++) {
    const atMs = Math.round(easeTime((m * step - fromDeg) / (toDeg - fromDeg)) * durationMs);
    const gap = atMs - last;
    if (gap < TICK_MIN_GAP_MS) continue;
    // Первый щелчок — на разгоне, ему не с чем сравнить шаг.
    ticks.push({ atMs, slow: ticks.length > 0 && gap >= TICK_SLOW_GAP_MS });
    last = atMs;
  }
  return ticks;
}

/** Доля времени, к которой колесо прошло долю пути `progress`, — обратная к кривой крутки. */
function easeTime(progress: number): number {
  const [x1, y1, x2, y2] = SPIN_EASE;
  const bezier = (u: number, a: number, b: number): number => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    if (bezier(mid, y1, y2) < progress) low = mid;
    else high = mid;
  }
  return bezier((low + high) / 2, x1, x2);
}
