import type { ItemRarity } from "../items/item-catalog.js";
import { levelCap } from "../items/item-rules.js";

/**
 * Витрина снаряжения в числах (docs/35-stage4-plan.md §3.6, Р11): каждые
 * игровые сутки — свои конкретные предметы с уже брошенными свойствами, за
 * самоцветы. Обновление витрины не продаётся (Р11, правило 4): новые
 * предметы приходят только с новыми сутками. Меняется здесь, в карте
 * конфигурации — docs/30-configuration-map.md.
 *
 * **Рабочие числа** — цены и состав ставит команда (О1, О9). Опора: 60
 * самоцветов в магазине — 50 ⭐, VIP даёт 10 в день, уровень аккаунта —
 * 10 каждый пятый. Редкий предмет падает и с забегов, поэтому стоит мало;
 * эпический и легендарный забег до перепроверки повтором не даёт вовсе
 * (WP5) — их цена выше, а открываются они уровнем, чтобы новичок не купил
 * силу раньше, чем научился играть (риск Р5, «покупной» рейтинг).
 */

export interface ShowcaseOffer {
  rarity: ItemRarity;
  gems: number;
  /** с какого уровня аккаунта место витрины занято этой редкостью; ниже — `fallback` */
  minAccountLevel: number;
  /** что лежит на месте до `minAccountLevel`; `null` — место пустует */
  fallback: { rarity: ItemRarity; gems: number } | null;
}

/** Места витрины по порядку на экране; слоты предметов в сутках не повторяются. */
export const SHOWCASE_OFFERS: readonly ShowcaseOffer[] = [
  { rarity: "rare", gems: 40, minAccountLevel: 1, fallback: null },
  { rarity: "rare", gems: 40, minAccountLevel: 1, fallback: null },
  { rarity: "epic", gems: 120, minAccountLevel: 5, fallback: { rarity: "rare", gems: 40 } },
  { rarity: "legendary", gems: 300, minAccountLevel: 10, fallback: { rarity: "epic", gems: 120 } },
];

/**
 * Уровень предмета витрины — как у добычи забега в первую минуту на лёгкой
 * сложности: от уровня аккаунта, не выше его потолка. Купленное не должно
 * быть сильнее того, что игрок мог бы выбить сам, на уровнях.
 */
export function showcaseLevel(accountLevel: number): number {
  return Math.min(levelCap(accountLevel), Math.max(1, 1 + Math.floor(accountLevel / 2)));
}

/** Что лежит на месте витрины у аккаунта этого уровня; `null` — место пустует. */
export function offerFor(offer: ShowcaseOffer, accountLevel: number): { rarity: ItemRarity; gems: number } | null {
  if (accountLevel >= offer.minAccountLevel) return { rarity: offer.rarity, gems: offer.gems };
  return offer.fallback;
}
