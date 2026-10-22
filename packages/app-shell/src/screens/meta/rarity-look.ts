/**
 * Облик редкости предмета v2 (design/art/direction-v2.md §4.4): не плоская
 * заливка с обводкой, а камень в оправе — свет снизу, грани, у старших
 * блеск и искры. Чем выше редкость, тем больше слоёв, и каждый новый слой
 * заметен рядом с предыдущей ступенью: редкость читается и без подписи, но
 * подпись остаётся — одним цветом редкость не передаётся (docs/27 §4.4).
 *
 * Здесь — только решения без React: их проверяют тесты, рисует
 * `RarityGlow` в `arsenal-parts.tsx`.
 */

export interface RarityLook {
  /** CSS-цвет тона — токен палитры */
  tone: string;
  /** свет снизу, как от камня в оправе */
  glow: boolean;
  /** огранка: светлые уголки оправы */
  facets: boolean;
  /** полоса блеска раз в несколько секунд */
  shine: boolean;
  /** ореол вокруг плитки */
  halo: boolean;
  /** мерцающие искры по углам */
  sparks: boolean;
}

const COMMON: RarityLook = { tone: "var(--color-border-strong)", glow: false, facets: false, shine: false, halo: false, sparks: false };

const LOOKS: Record<string, RarityLook> = {
  common: COMMON,
  uncommon: { tone: "var(--color-success)", glow: true, facets: false, shine: false, halo: false, sparks: false },
  rare: { tone: "var(--color-info)", glow: true, facets: true, shine: false, halo: false, sparks: false },
  epic: { tone: "var(--color-passive)", glow: true, facets: true, shine: true, halo: false, sparks: false },
  legendary: { tone: "var(--color-elite)", glow: true, facets: true, shine: true, halo: true, sparks: false },
  mythic: { tone: "var(--color-danger)", glow: true, facets: true, shine: true, halo: true, sparks: true },
};

/** Незнакомая редкость от сервера новее клиента рисуется как обычная. */
export function rarityLook(rarity: string): RarityLook {
  return LOOKS[rarity] ?? COMMON;
}

/** Период полосы блеска — тот же, что у кнопки «Играть». */
export const RARITY_SHINE_PERIOD_MS = 4_500;

/**
 * Задержка блеска по ключу предмета: в сетке инвентаря двадцать эпических
 * плиток, вспыхнувших разом, мигали бы строем. Хэш строки — стабильный:
 * плитка не меняет фазу при перерисовке.
 */
export function shineDelayMs(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % RARITY_SHINE_PERIOD_MS;
}
