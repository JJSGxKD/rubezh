/**
 * Портрет героя-спрайта на экранах меню (design/art/direction-v2.md §4.4) —
 * за тем же флагом «Черновой арт», что арт в забеге: до решения тимлида по
 * направлению (design/art/README.md, «Решения для тимлида») игрок видит
 * прежнюю фигуру. Кадр покоя вектором — `design/art/src/portraits.mjs`:
 * растровый кадр атласа крупно поплыл бы.
 */
export const HERO_PORTRAIT_URL = new URL("../../../../../design/art/out/portrait-hero-keeper.svg", import.meta.url).href;

/** Адрес портрета или `null` — тогда рисуется прежняя фигура. */
export function heroPortrait(sprites: boolean, devAllowed: boolean): string | null {
  return sprites && devAllowed ? HERO_PORTRAIT_URL : null;
}
