import { APPEARANCE_ORDER, DEFAULT_APPEARANCE, type KnownAppearance } from "./appearance-rules";

/**
 * Рисунки обликов (tasks/T-0238, design/art/backlog.md, п. 7): портрет для
 * арсенала, голова для кружка аватара и карточка экрана «Облик», по десять
 * штук. Адреса — одной картой.
 *
 * `?no-inline`: рисунки по три килобайта Vite иначе вшил бы в код строкой, и
 * тридцать штук уехали бы в первую загрузку вместе с кружком аватара. Файлом
 * они грузятся, только когда `<img>` дошёл до экрана; в код попадают одни
 * адреса (`pnpm budget`). Литералы внутри `new URL(…, import.meta.url)` — так
 * Vite находит файлы, цикл по именам их бы не увидел.
 */
const PORTRAIT: Readonly<Record<KnownAppearance, string>> = {
  keeper: new URL("../../../../../design/art/out/portrait-hero-keeper.svg?no-inline", import.meta.url).href,
  frost: new URL("../../../../../design/art/out/portrait-hero-frost.svg?no-inline", import.meta.url).href,
  herbalist: new URL("../../../../../design/art/out/portrait-hero-herbalist.svg?no-inline", import.meta.url).href,
  gilded: new URL("../../../../../design/art/out/portrait-hero-gilded.svg?no-inline", import.meta.url).href,
  vityaz: new URL("../../../../../design/art/out/portrait-hero-vityaz.svg?no-inline", import.meta.url).href,
  vedunya: new URL("../../../../../design/art/out/portrait-hero-vedunya.svg?no-inline", import.meta.url).href,
  ohotnitsa: new URL("../../../../../design/art/out/portrait-hero-ohotnitsa.svg?no-inline", import.meta.url).href,
  skomoroh: new URL("../../../../../design/art/out/portrait-hero-skomoroh.svg?no-inline", import.meta.url).href,
  knyaz: new URL("../../../../../design/art/out/portrait-hero-knyaz.svg?no-inline", import.meta.url).href,
  navi: new URL("../../../../../design/art/out/portrait-hero-navi.svg?no-inline", import.meta.url).href,
};

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

const CARD: Readonly<Record<KnownAppearance, string>> = {
  keeper: new URL("../../../../../design/art/out/card-hero-keeper.svg?no-inline", import.meta.url).href,
  frost: new URL("../../../../../design/art/out/card-hero-frost.svg?no-inline", import.meta.url).href,
  herbalist: new URL("../../../../../design/art/out/card-hero-herbalist.svg?no-inline", import.meta.url).href,
  gilded: new URL("../../../../../design/art/out/card-hero-gilded.svg?no-inline", import.meta.url).href,
  vityaz: new URL("../../../../../design/art/out/card-hero-vityaz.svg?no-inline", import.meta.url).href,
  vedunya: new URL("../../../../../design/art/out/card-hero-vedunya.svg?no-inline", import.meta.url).href,
  ohotnitsa: new URL("../../../../../design/art/out/card-hero-ohotnitsa.svg?no-inline", import.meta.url).href,
  skomoroh: new URL("../../../../../design/art/out/card-hero-skomoroh.svg?no-inline", import.meta.url).href,
  knyaz: new URL("../../../../../design/art/out/card-hero-knyaz.svg?no-inline", import.meta.url).href,
  navi: new URL("../../../../../design/art/out/card-hero-navi.svg?no-inline", import.meta.url).href,
};

function known(id: string): KnownAppearance {
  return APPEARANCE_ORDER.find((candidate) => candidate === id) ?? DEFAULT_APPEARANCE;
}

/** Портрет облика для арсенала; незнакомый id — Хранитель. */
export function appearancePortraitUrl(id: string): string {
  return PORTRAIT[known(id)];
}

/** Голова облика для кружка аватара; незнакомый id — Хранитель. */
export function appearanceHeadUrl(id: string): string {
  return HEAD[known(id)];
}

/** Карточка облика для сетки экрана «Облик»; незнакомый id — Хранитель. */
export function appearanceCardUrl(id: string): string {
  return CARD[known(id)];
}
