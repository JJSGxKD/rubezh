import { priceFor, type PaymentMethod, type Product, type RatesSnapshot } from "@bh/fx";
import type { PlatformId } from "../../platforms/ports/platform.js";

/**
 * Способы оплаты игры (docs/35-stage4-plan.md WP9 → WP10) и цена товара в
 * единицах способа. Здесь, а не у магазина: цену по тому же правилу берут и
 * магазин, и VIP, а способ оплаты — забота модуля оплаты.
 */

/** Пока один: в Mini App цифровое продаётся только за звёзды. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  { id: "telegram_stars", platform: "telegram", provider: "telegram_stars", currency: "XTR", minAmount: "1", maxAmount: "10000", fee: { percent: "0", placement: "inside" }, order: 1 },
];

/**
 * Ручная цена курсов не требует — снимок для неё пустой. Товар без ручной
 * цены у способа при пустом снимке честно недоступен, а не стоит ноль.
 */
const NO_RATES: RatesSnapshot = { id: "manual-only", takenAt: new Date(0), rates: new Map(), payout: new Map() };

/** Способ оплаты площадки: первый по порядку; `undefined` — на площадке платить нечем. */
export function methodFor(platform: PlatformId): PaymentMethod | undefined {
  return [...PAYMENT_METHODS].sort((a, b) => a.order - b.order).find((method) => method.platform === platform);
}

/** Цена товара способом оплаты в его единицах; `null` — способ этот товар не продаёт. */
export function priceIn(product: Product, method: PaymentMethod): number | null {
  const price = priceFor(product, method, NO_RATES);
  return price.status === "available" ? price.amount.toNumber() : null;
}
