import { DEFAULT_APPEARANCE } from "./appearance-rules";
import { appearancePortraitUrl } from "./appearance-art";

/**
 * Портрет героя на экранах меню (design/art/direction-v2.md §4.4): портрет
 * **выбранного облика** (tasks/T-0238), а не только Хранителя. Показ — за арт
 * зрителя (флаг арта и «Графика», `state/viewer-art.ts`): без арта игрок видит
 * прежнюю фигуру. Кадр покоя вектором — `design/art/src/portraits.mjs`:
 * растровый кадр атласа крупно поплыл бы.
 *
 * `appearance` ещё не пришёл (загрузка, гость) — Хранитель, как и у облика,
 * которого клиент не знает.
 */
export function heroPortrait(viewerArt: boolean, appearance: string | undefined): string | null {
  return viewerArt ? appearancePortraitUrl(appearance ?? DEFAULT_APPEARANCE) : null;
}
