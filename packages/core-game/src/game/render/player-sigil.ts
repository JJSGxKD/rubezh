/**
 * Знак под ногами героя-спрайта (design/art/direction-v2.md §4.1).
 *
 * Кольца здоровья и опыта рассчитаны на героя-круг: вокруг спрайта они режут
 * тело. У спрайта здоровье — дугой эллипса на земле, как оберег под ногами, а
 * опыт уходит в HUD: в бою его не читают. Дуга тает с тыльной стороны,
 * поэтому остаток всегда спереди, под ногами, и спрайт его не закрывает.
 *
 * Здесь — только числа без Phaser: их проверяют тесты, а рисует
 * `PlayerRings`. Рендер, на исход забега не влияет.
 */

/**
 * Размеры знака в радиусах персонажа: центр — у ступней спрайта. Знак шире
 * подола: под спрайтом эллипс в радиус шириной прятался целиком.
 */
export const SIGIL = {
  /** насколько ниже центра тела стоят ступни */
  offsetY: 1.5,
  rx: 1.75,
  ry: 0.6,
  /** толщина дуги */
  width: 0.22,
} as const;

/** Передняя точка эллипса — к зрителю, ниже центра: y экрана растёт вниз. */
const FRONT = Math.PI / 2;

/**
 * Дуга здоровья: доля `fill` от полного эллипса, симметрично вокруг передней
 * точки. `null` — здоровья нет, рисовать нечего.
 */
export function hpArc(fill: number): { start: number; end: number } | null {
  if (!(fill > 0)) return null;
  const half = Math.PI * Math.min(1, fill);
  return { start: FRONT - half, end: FRONT + half };
}

/** Точки дуги эллипса подряд: x, y, x, y… — `segments + 1` точек. */
export function ellipsePoints(cx: number, cy: number, rx: number, ry: number, start: number, end: number, segments: number): number[] {
  const points: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = start + ((end - start) * i) / Math.max(1, segments);
    points.push(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry);
  }
  return points;
}

/** Вспышка нового уровня — полсекунды. */
export const LEVEL_FLASH_TICKS = 30;

/**
 * Новый уровень — светлое кольцо расходится от знака и гаснет: момент виден
 * на герое, а не только в углу экрана. `null` — вспышки нет.
 */
export function levelFlash(age: number): { scale: number; alpha: number } | null {
  if (age < 0 || age >= LEVEL_FLASH_TICKS) return null;
  const t = age / LEVEL_FLASH_TICKS;
  return { scale: 1 + 1.4 * (1 - (1 - t) * (1 - t)), alpha: 0.9 * (1 - t) };
}

/** Ободок щита «Эгиды» — шире знака: здоровье остаётся читаемым внутри. */
export const SHIELD_RIM = { scale: 1.22, color: 0xfff6c8 } as const;

/** Бусин щита рисуется не больше этого: дальше их не сосчитать взглядом. */
export const SHIELD_BEADS_MAX = 5;

/** Шаг между бусинами по эллипсу, радианы. */
const BEAD_STEP = 0.38;

/**
 * Углы бусин щита — по одной на оставшееся попадание, симметрично вокруг
 * передней точки: сколько ударов ещё примет щит, видно под ногами.
 */
export function shieldBeads(hits: number): number[] {
  const count = Math.max(0, Math.min(SHIELD_BEADS_MAX, Math.floor(hits)));
  return Array.from({ length: count }, (_, i) => FRONT + (i - (count - 1) / 2) * BEAD_STEP);
}
