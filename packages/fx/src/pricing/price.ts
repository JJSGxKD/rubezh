import { deviation } from "../accept.js";
import type { CurrencyCode } from "../currencies.js";
import { decimal, positive, type Decimal, type DecimalInput } from "../decimal.js";
import { convert, toMinorUnits, usdPerUnit, type RatesSnapshot } from "../rates.js";
import { roundPrice } from "./rounding.js";

/**
 * Цена товара для способа оплаты (docs/35-stage4-plan.md, §3.12, Р33).
 *
 * У товара — **базовая цена** в опорной валюте, как в сторах, и, где нужно,
 * **ручная цена** для способа: «ровно 50 ⭐» не должно превращаться в 49 или
 * 51 от движения курса. Раздельная экономика площадок (03-notes-and-risks.md)
 * держится ручной ценой, а пересчёт — умолчание.
 *
 * Цены пересчитываются по расписанию и при скачке курса, а не от каждого
 * обновления: игрок видит стабильные цены. Прайс-лист помнит снимок, по
 * которому посчитан, и счёт фиксирует цену вместе с ним.
 */

export interface PaymentMethod {
  /** `telegram_stars`, `web_card_rub`, `ton_gram` — ключ ручной цены у товара */
  id: string;
  /** площадка: `telegram`, `max`, `vk`, `web` */
  platform: string;
  /** провайдер за портом оплаты */
  provider: string;
  currency: CurrencyCode;
  /** пределы суммы одного платежа у провайдера, в единицах валюты */
  minAmount?: string;
  maxAmount?: string;
  /**
   * Комиссия провайдера: `inside` — удерживается из суммы, `on_top` —
   * провайдер берёт её с игрока сверх цены. На цену она не влияет, на
   * выручку — да (`revenue.ts`).
   */
  fee: { percent: string; placement: "inside" | "on_top" };
  /** порядок в выборе способа — меньше выше */
  order: number;
}

export interface Product {
  id: string;
  base: { currency: CurrencyCode; amount: string };
  /** ручная цена по способу оплаты — побеждает пересчёт */
  manual?: Readonly<Record<string, string>>;
}

export type MethodPrice =
  | { status: "available"; method: string; currency: CurrencyCode; amount: Decimal; minor: bigint; from: "manual" | "converted" }
  /** сумма вне пределов провайдера — способ для этого товара не предлагается */
  | { status: "unavailable"; method: string; reason: "above_max" | "below_min" | "no_rate" };

export function priceFor(product: Product, method: PaymentMethod, snapshot: RatesSnapshot): MethodPrice {
  const manual = product.manual?.[method.id];
  let amount: Decimal;
  let from: "manual" | "converted";
  if (manual !== undefined) {
    amount = positive(manual, `ручная цена ${product.id} для ${method.id}`);
    from = "manual";
  } else {
    try {
      amount = roundPrice(convert(positive(product.base.amount, `цена ${product.id}`), product.base.currency, method.currency, snapshot), method.currency);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "MissingRateError") return { status: "unavailable", method: method.id, reason: "no_rate" };
      throw error;
    }
    from = "converted";
  }

  // Ниже минимума провайдера пересчитанную цену поднимаем до него: товар
  // дешевле, чем разрешает способ, иначе не купить вовсе. Ручную — не
  // трогаем: это решение человека, и оно должно быть видно.
  if (method.minAmount !== undefined && amount.lessThan(method.minAmount)) {
    if (from === "manual") return { status: "unavailable", method: method.id, reason: "below_min" };
    amount = roundPrice(method.minAmount, method.currency);
  }
  if (method.maxAmount !== undefined && amount.greaterThan(method.maxAmount)) return { status: "unavailable", method: method.id, reason: "above_max" };

  return { status: "available", method: method.id, currency: method.currency, amount, minor: toMinorUnits(amount, method.currency, "up"), from };
}

export interface PriceBook {
  snapshotId: string;
  computedAt: Date;
  prices: ReadonlyMap<string, ReadonlyMap<string, MethodPrice>>;
}

export function priceBook(products: readonly Product[], methods: readonly PaymentMethod[], snapshot: RatesSnapshot, now: Date): PriceBook {
  const prices = new Map<string, Map<string, MethodPrice>>();
  for (const product of products) {
    prices.set(product.id, new Map(methods.map((method) => [method.id, priceFor(product, method, snapshot)])));
  }
  return { snapshotId: snapshot.id, computedAt: now, prices };
}

export interface RepricePolicy {
  /** прайс-лист старше — пересчитывается по расписанию */
  maxAgeMs: number;
  /** сдвиг курса любой из валют прайс-листа больше этой доли — пересчёт сразу */
  jumpThreshold: DecimalInput;
}

/**
 * Пора ли пересчитать прайс-лист: по возрасту или потому, что курс хоть одной
 * валюты ушёл дальше порога. Сравниваются все валюты обоих снимков, а не
 * только валюты цен: цена в звёздах, пересчитанная из рублей, зависит и от
 * рубля. Появившийся или пропавший курс — тоже повод: по пропавшему продавать
 * уже нельзя, а по появившемуся открывается способ оплаты.
 */
export function needsReprice(book: PriceBook, bookSnapshot: RatesSnapshot, current: RatesSnapshot, now: Date, policy: RepricePolicy): boolean {
  if (now.getTime() - book.computedAt.getTime() >= policy.maxAgeMs) return true;
  const threshold = decimal(policy.jumpThreshold);
  const codes = new Set<CurrencyCode>([...bookSnapshot.rates.keys(), ...current.rates.keys()]);
  for (const code of codes) {
    const before = bookSnapshot.rates.has(code);
    if (before !== current.rates.has(code)) return true;
    if (!before) continue;
    if (deviation(usdPerUnit(current, code), usdPerUnit(bookSnapshot, code)).greaterThan(threshold)) return true;
  }
  return false;
}
