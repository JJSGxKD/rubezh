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

export type ShopBadge = "hit" | "choice" | "best";

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

/** Набор с лучшей ценой самоцвета — по расчёту, независимо от того, какая метка на нём в итоге стоит. */
export function bestPriceId(skus: readonly ShopSku[], price: PriceOf): string | null {
  let best: { id: string; rate: number } | null = null;
  for (const sku of skus) {
    const rate = gemsPerStar(sku, price);
    if (rate !== null && (best === null || rate > best.rate)) best = { id: sku.id, rate };
  }
  return best?.id ?? null;
}

/**
 * Бейдж товара, одна метка на набор: «Хит» команды → «Выбор игроков» (`choiceId` —
 * набор, посчитанный в `shop-choice.ts`) → «Лучшая цена» у самого выгодного набора
 * самоцветов. Метка, уступившая место, на другой набор не переезжает.
 */
export function badgesOf(skus: readonly ShopSku[], price: PriceOf, choiceId: string | null = null): Map<string, ShopBadge> {
  const result = new Map<string, ShopBadge>();
  for (const sku of skus) if (sku.badge !== undefined) result.set(sku.id, sku.badge);
  if (choiceId !== null && !result.has(choiceId)) result.set(choiceId, "choice");
  const best = bestPriceId(skus, price);
  if (best !== null && !result.has(best)) result.set(best, "best");
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
  // Лучшая цена — по расчёту, а не по метке: «Выбор игроков» мог занять её место.
  const best = bestPriceId(sellable, price);
  return best ?? sellable[0]?.id ?? null;
}
