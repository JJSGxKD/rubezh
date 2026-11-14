import { APPEARANCE_ORDER, DEFAULT_APPEARANCE, type KnownAppearance } from "./appearance-rules";

/**
 * Головы обликов для кружка аватара (tasks/T-0238) — отдельным модулем от
 * портретов и карточек: кружок живёт в первой загрузке, и вместе с ним не
 * должны ехать адреса двадцати рисунков, которые нужны только экрану «Облик»
 * и арсеналу. Файлы лежат рядом с картой остальных рисунков (`appearance-art.ts`)
 * и грузятся по требованию (`?no-inline`, причина — там же).
 */
const HEAD: Readonly<Record<KnownAppearance, string>> = {
  keeper: new URL("../../../../../design/art/out/avatar-hero-keeper.svg?no-inline", import.meta.url).href,
  frost: new URL("../../../../../design/art/out/avatar-hero-frost.svg?no-inline", import.meta.url).href,
  herbalist: new URL("../../../../../design/art/out/avatar-hero-herbalist.svg?no-inline", import.meta.url).href,
  gilded: new URL("../../../../../design/art/out/avatar-hero-gilded.svg?no-inline", import.meta.url).href,
  vityaz: new URL("../../../../../design/art/out/avatar-hero-vityaz.svg?no-inline", import.meta.url).href,
  vedunya: new URL("../../../../../design/art/out/avatar-hero-vedunya.svg?no-inline", import.meta.url).href,
  ohotnitsa: new URL("../../../../../design/art/out/avatar-hero-ohotnitsa.svg?no-inline", import.meta.url).href,
  skomoroh: new URL("../../../../../design/art/out/avatar-hero-skomoroh.svg?no-inline", import.meta.url).href,
  knyaz: new URL("../../../../../design/art/out/avatar-hero-knyaz.svg?no-inline", import.meta.url).href,
  navi: new URL("../../../../../design/art/out/avatar-hero-navi.svg?no-inline", import.meta.url).href,
};

/** Голова облика для кружка аватара; незнакомый id — Хранитель. */
export function appearanceHeadUrl(id: string): string {
  return HEAD[APPEARANCE_ORDER.find((candidate) => candidate === id) ?? DEFAULT_APPEARANCE];
}
