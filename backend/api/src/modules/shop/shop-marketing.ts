import type { ShopSku } from "./shop-catalog.js";

/**
 * Подача товара в магазине (docs/35-stage4-plan.md §3.6): бейджи, выгода и
 * что предложить игроку первым. **Только правда** (решение 01.10.2026): выгода
 * считается от самого дорогого за самоцвет набора, «Лучшая цена» — у набора
 * с самой дешёвой ценой самоцвета, зачёркнутая цена бывает только у акции с
 * настоящей прежней ценой. Выдуманная «старая» цена — недостоверная
 * информация о цене (ЗоЗПП, закон о рекламе), и магазин бота за неё теряет
 * больше, чем выигрывает.
 */

export type ShopBadge = "hit" | "best";

/** Цена набора у способа оплаты игрока; `null` — этот способ товар не продаёт. */
export type PriceOf = (sku: ShopSku) => number | null;

function gemsPerStar(sku: ShopSku, price: PriceOf): number | null {
  const stars = price(sku);
  const gems = sku.contents.gems;
  if (sku.kind !== "gems" || stars === null || stars <= 0 || gems === undefined) return null;
  return gems / stars;
}

/**
 * Выгода набора самоцветов в процентах против самого дорогого за самоцвет
 * набора; у самого дорогого и у не-самоцветов — `null`. Округление вниз:
 * обещать больше, чем есть, нельзя.
 */
export function gemValuePct(skus: readonly ShopSku[], price: PriceOf): Map<string, number> {
  const rates = skus.flatMap((sku) => {
    const rate = gemsPerStar(sku, price);
    return rate === null ? [] : [{ id: sku.id, rate }];
  });
  const base = Math.min(...rates.map((entry) => entry.rate));
  const result = new Map<string, number>();
  for (const { id, rate } of rates) {
    const pct = Math.floor((rate / base - 1) * 100);
    if (pct > 0) result.set(id, pct);
  }
  return result;
}

/** Бейдж товара: ручной «Хит» у каталога сильнее «Лучшей цены»; лучшая — одна, у самого выгодного набора самоцветов. */
export function badgesOf(skus: readonly ShopSku[], price: PriceOf): Map<string, ShopBadge> {
  const result = new Map<string, ShopBadge>();
  let best: { id: string; rate: number } | null = null;
  for (const sku of skus) {
    if (sku.badge !== undefined) result.set(sku.id, sku.badge);
    const rate = gemsPerStar(sku, price);
    if (rate !== null && (best === null || rate > best.rate)) best = { id: sku.id, rate };
  }
  if (best !== null && !result.has(best.id)) result.set(best.id, "best");
  return result;
}

export interface RecommendInput {
  /** купленные разовые товары */
  owned: ReadonlySet<string>;
  /** сколько у игрока надетых предметов — вкладывается ли он в снаряжение */
  equipped: number;
}

/**
 * Что предложить первым — под игрока: новичку — стартовый набор, пока он не
 * куплен; тому, кто уже носит снаряжение, — набор на его улучшение;
 * остальным — самоцветы по лучшей цене. `null` — предложить нечего.
 */
export function recommendedSku(skus: readonly ShopSku[], price: PriceOf, input: RecommendInput): string | null {
  const sellable = skus.filter((sku) => price(sku) !== null && !(sku.once && input.owned.has(sku.id)));
  const starter = sellable.find((sku) => sku.kind === "starter");
  if (starter !== undefined) return starter.id;
  const bundle = sellable.find((sku) => sku.kind === "bundle");
  if (input.equipped > 0 && bundle !== undefined) return bundle.id;
  const best = [...badgesOf(sellable, price)].find(([, badge]) => badge === "best")?.[0];
  return best ?? sellable[0]?.id ?? null;
}
