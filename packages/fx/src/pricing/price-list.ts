import { currency, type CurrencyCode } from "../currency.js";
import { Decimal } from "../decimal.js";
import { relativeChange } from "../rates/checks.js";
import { convert, type RateSnapshot } from "../rates/snapshot.js";
import type { PaymentMethod } from "./payment-method.js";
import { baseUsd, type Product } from "./product.js";
import { DEFAULT_ROUNDING, roundPrice, type RoundingRule } from "./rounding.js";

/**
 * Прайс-лист: цена каждого товара для каждого способа оплаты по снимку
 * курсов (docs/35-stage4-plan.md §3.12, Р33). Пересчитывается по расписанию
 * и при скачке курса больше порога, а не на каждое обновление: игрок видит
 * стабильные цены. Счёт фиксирует цену и снимок.
 */
export interface PricingRules {
  rounding: Record<CurrencyCode, RoundingRule>;
  /** Через сколько мс прайс-лист пересчитывается по расписанию. */
  maxAgeMs: number;
  /** Изменение курса, при котором пересчёт не ждёт расписания: 0.05 — 5 %. */
  repriceJumpRatio: Decimal;
  /** Сколько мс можно продавать по устаревшему курсу, прежде чем товар в этой валюте закрывается. */
  staleSellingMaxMs: number;
}

const HOUR_MS = 3_600_000;

/** Рабочие значения (Р31). */
export const DEFAULT_PRICING_RULES: PricingRules = {
  rounding: DEFAULT_ROUNDING,
  maxAgeMs: 24 * HOUR_MS,
  repriceJumpRatio: Decimal.of("0.05"),
  staleSellingMaxMs: 72 * HOUR_MS,
};

export interface MethodPrice {
  productId: string;
  methodId: string;
  currency: CurrencyCode;
  amount: Decimal;
  /** Та же сумма в минорных единицах — то, что уходит провайдеру и в базу. */
  minorUnits: bigint;
  manual: boolean;
  /** Цена упёрлась в предел способа — товар для этого способа, возможно, не годится. */
  clamped: "min" | "max" | null;
}

export interface PriceList {
  snapshotId: string;
  computedAt: number;
  prices: MethodPrice[];
}

export function priceFor(product: Product, method: PaymentMethod, snapshot: RateSnapshot, rules: PricingRules): MethodPrice {
  const decimals = currency(method.currency).decimals;
  const manual = product.manual[method.id];
  if (manual) {
    return { productId: product.id, methodId: method.id, currency: method.currency, amount: manual, minorUnits: manual.toMinor(decimals), manual: true, clamped: null };
  }

  let usd = baseUsd(product);
  // Комиссия сверху — часть цены, которую видит игрок; внутри — из выручки, цену не меняет.
  if (method.fee.mode === "on_top") usd = usd.mul(Decimal.ONE.add(method.fee.rate));
  let amount = roundPrice(convert(usd, "USD", method.currency, snapshot), rules.rounding[method.currency]);

  let clamped: MethodPrice["clamped"] = null;
  if (method.min && amount.lt(method.min)) {
    amount = method.min;
    clamped = "min";
  } else if (method.max && amount.gt(method.max)) {
    amount = method.max;
    clamped = "max";
  }
  return { productId: product.id, methodId: method.id, currency: method.currency, amount, minorUnits: amount.toMinor(decimals), manual: false, clamped };
}

export function computePriceList(products: readonly Product[], methods: readonly PaymentMethod[], snapshot: RateSnapshot, rules: PricingRules): PriceList {
  const prices: MethodPrice[] = [];
  for (const product of products) {
    for (const method of methods) {
      if (!method.enabled) continue;
      prices.push(priceFor(product, method, snapshot, rules));
    }
  }
  return { snapshotId: snapshot.id, computedAt: snapshot.at, prices };
}

export type RepriceReason = "no_prices" | "aged" | "rate_jump";

export interface RepriceDecision {
  reprice: boolean;
  reason: RepriceReason | null;
  /** Валюты, у которых курс ушёл дальше порога. */
  jumped: CurrencyCode[];
}

export interface RepriceInput {
  current: PriceList | null;
  /** Снимок, по которому посчитан текущий прайс-лист. */
  currentSnapshot: RateSnapshot | null;
  latest: RateSnapshot;
  methods: readonly PaymentMethod[];
  now: number;
  rules: PricingRules;
}

/** Пересчитывать ли прайс-лист: нет цен, вышел срок или курс какой-то из валют оплаты прыгнул. */
export function shouldReprice(input: RepriceInput): RepriceDecision {
  if (!input.current || !input.currentSnapshot) return { reprice: true, reason: "no_prices", jumped: [] };
  if (input.now - input.current.computedAt >= input.rules.maxAgeMs) return { reprice: true, reason: "aged", jumped: [] };

  const jumped: CurrencyCode[] = [];
  const used = new Set(input.methods.filter((method) => method.enabled).map((method) => method.currency));
  for (const code of used) {
    const before = input.currentSnapshot.quotes[code];
    const after = input.latest.quotes[code];
    if (!before || !after) continue;
    if (relativeChange(after.usdPerUnit, before.usdPerUnit).gt(input.rules.repriceJumpRatio)) jumped.push(code);
  }
  return jumped.length > 0 ? { reprice: true, reason: "rate_jump", jumped } : { reprice: false, reason: null, jumped };
}

export type SellVerdict = { ok: true } | { ok: false; reason: "missing_rate" | "stale_too_long" };

/**
 * Можно ли продавать за валюту по этому снимку: устаревший курс терпим не
 * дольше `staleSellingMaxMs` от момента, когда он был принят.
 */
export function canSellWith(snapshot: RateSnapshot, code: CurrencyCode, now: number, rules: PricingRules): SellVerdict {
  const quote = snapshot.quotes[code];
  if (!quote) return { ok: false, reason: "missing_rate" };
  if (quote.stale && now - quote.acceptedAt > rules.staleSellingMaxMs) return { ok: false, reason: "stale_too_long" };
  return { ok: true };
}
