import { Decimal } from "../decimal.js";
import type { PaymentMethod } from "./payment-method.js";

/**
 * Товар для слоя цен (docs/35-stage4-plan.md §3.12, Р33): базовая цена в
 * опорной валюте или ценовая ступень, как в сторах, и, где нужно, ручная
 * цена для способа — «ровно 50 ⭐». Состав товара и граница с гачей (Р11) —
 * дело каталога магазина (WP10), здесь только цена.
 */
export type BasePrice = { usd: Decimal } | { tier: number };

export interface Product {
  id: string;
  base: BasePrice;
  /** Ручная цена по идентификатору способа — в валюте способа, как есть, без округления и пересчёта. */
  manual: Readonly<Partial<Record<string, Decimal>>>;
}

/**
 * Ценовые ступени в долларах — рабочие значения (Р31). Ступень вместо суммы
 * держит прайс-лист ровным: два товара одной ступени стоят одинаково на
 * каждой площадке.
 */
export const PRICE_TIERS: readonly Decimal[] = ["0.99", "1.99", "2.99", "4.99", "9.99", "19.99", "49.99", "99.99"].map((text) => Decimal.of(text));

export function baseUsd(product: Product): Decimal {
  if ("usd" in product.base) return product.base.usd;
  const tier = PRICE_TIERS[product.base.tier];
  if (!tier) throw new Error(`товар ${product.id}: ступени ${product.base.tier} нет`);
  return tier;
}

export function findProductProblems(products: readonly Product[], methods: readonly PaymentMethod[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const methodIds = new Set(methods.map((method) => method.id));

  for (const product of products) {
    const where = `товар ${product.id}`;
    if (ids.has(product.id)) problems.push(`${where}: идентификатор повторяется`);
    ids.add(product.id);
    if ("usd" in product.base) {
      if (!product.base.usd.isPositive()) problems.push(`${where}: базовая цена должна быть больше нуля`);
    } else if (!Number.isInteger(product.base.tier) || product.base.tier < 0 || product.base.tier >= PRICE_TIERS.length) {
      problems.push(`${where}: ступени ${product.base.tier} нет (всего ${PRICE_TIERS.length})`);
    }
    for (const [methodId, price] of Object.entries(product.manual)) {
      if (!methodIds.has(methodId)) problems.push(`${where}: ручная цена для неизвестного способа ${methodId}`);
      if (price && !price.isPositive()) problems.push(`${where}: ручная цена для ${methodId} должна быть больше нуля`);
    }
  }
  return problems;
}
