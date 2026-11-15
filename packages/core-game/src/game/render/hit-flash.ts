/**
 * Вспышка попадания у спрайта чернового арта (design/art/registry.md, F-06;
 * design/art/direction-v2.md §4.5).
 *
 * Вспышка — белая заливка: у фигуры она короткий отклик, а у спрайта стирает
 * рисунок. Под сплошным огнём (аура, обереги, весь арсенал) удар приходит
 * чаще, чем гаснет вспышка, и босс оставался белым силуэтом весь бой. Поэтому
 * у спрайта вспышка не перезапускается каждым ударом: после неё — пауза, в
 * которой удары вспышку не зажигают. Рендер, на исход забега не влияет.
 */

/** Сколько тиков держится вспышка попадания у фигуры — около двух десятых секунды. */
export const HIT_FLASH_TICKS = 7;

/** Вспышка неубиваемого — кайма ярче: короче заливки, чтобы не спорить с отталкиванием. */
export const UNKILLABLE_FLASH_TICKS = 6;

/**
 * Как вспыхивает враг при попадании: `fill` — белая заливка, `rim` — кайма ярче, `none` — не вспыхивает.
 * У неубиваемого заливки нет: белая говорит «ранен», а он не ранен — удар его только отодвигает (Р205).
 * `age` — тиков с последнего попадания.
 */
export function hitFlashStyle(unkillable: boolean, age: number): "fill" | "rim" | "none" {
  if (unkillable) return age < UNKILLABLE_FLASH_TICKS ? "rim" : "none";
  return age < HIT_FLASH_TICKS ? "fill" : "none";
}

/** Сколько тиков горит вспышка спрайта. */
export const ART_HIT_FLASH_TICKS = 3;

/** Пауза после вспышки: под сплошным огнём спрайт бел не больше четверти времени. */
export const ART_HIT_FLASH_GAP = 10;

/** «Вспышек не было»: настолько давно, что пауза любой длины уже прошла. */
export const NO_FLASH = -1_000_000;

/**
 * Начало вспышки, которая горит в тик `tick`, или `null` — спрайт без
 * вспышки. `flashStart` — начало прошлой вспышки этого слота; вернувшееся
 * значение рендер запоминает вместо него.
 */
export function artFlashStart(tick: number, hitTick: number, flashStart: number): number | null {
  if (tick - hitTick >= ART_HIT_FLASH_TICKS) return null;
  const since = tick - flashStart;
  if (since < ART_HIT_FLASH_TICKS) return flashStart;
  if (since < ART_HIT_FLASH_TICKS + ART_HIT_FLASH_GAP) return null;
  return tick;
}
