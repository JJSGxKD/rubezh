import { describe, expect, it } from "vitest";
import type { CurrencyCode } from "../src/currencies.js";
import { Decimal } from "../src/decimal.js";
import { needsReprice, priceBook, priceFor, type PaymentMethod, type Product } from "../src/pricing/price.js";
import { revenueOf } from "../src/pricing/revenue.js";
import { roundPrice } from "../src/pricing/rounding.js";
import { rateOf, type Rate, type RatesSnapshot } from "../src/rates.js";

/**
 * Слой цен (docs/35-stage4-plan.md, WP9, Р33). Критерий приёмки: цена в
 * звёздах, рублях и Gram считается из одной базовой, округляется по правилам
 * валюты и не прыгает от каждого обновления курса; платёж несёт снимок, и
 * выручка пересчитывается из него.
 */

const T0 = new Date("2026-09-25T12:00:00Z");
const HOUR = 3_600_000;

function snapshot(id: string, rates: Partial<Record<CurrencyCode, string>>, payout: Partial<Record<CurrencyCode, string>> = {}): RatesSnapshot {
  const toMap = (entries: Partial<Record<CurrencyCode, string>>) =>
    new Map(Object.entries(entries).map(([code, usd]) => [code as CurrencyCode, rateOf(code as CurrencyCode, usd as string, ["test"], T0)] as [CurrencyCode, Rate]));
  return { id, takenAt: T0, rates: toMap(rates), payout: toMap(payout) };
}

// Курсы 25 сентября 2026: доллар — 84.6952 ₽, Gram — 1.43 $, звезда — 0.013 $ игроку и 0.0105 $ нам.
const RUB = new Decimal(1).div("84.6952").toFixed();
const TODAY = snapshot("today", { RUB, GRAM: "1.43", XTR: "0.013" }, { XTR: "0.0105" });

const METHODS: Record<string, PaymentMethod> = {
  stars: { id: "telegram_stars", platform: "telegram", provider: "telegram_stars", currency: "XTR", minAmount: "1", maxAmount: "10000", fee: { percent: "0", placement: "inside" }, order: 1 },
  card: { id: "web_card_rub", platform: "web", provider: "acquiring", currency: "RUB", minAmount: "100", fee: { percent: "0.03", placement: "inside" }, order: 1 },
  gram: { id: "ton_gram", platform: "web", provider: "ton_connect", currency: "GRAM", fee: { percent: "0", placement: "on_top" }, order: 2 },
};

const GEMS_SMALL: Product = { id: "gems_small", base: { currency: "USD", amount: "0.99" } };

describe("округление цены", () => {
  it.each([
    ["XTR", "76.15", "77"],
    ["XTR", "50", "50"],
    ["RUB", "83.85", "89"],
    ["RUB", "89", "89"],
    ["RUB", "90", "99"],
    ["RUB", "243", "249"],
    ["RUB", "999.5", "1099"],
    ["RUB", "1087", "1099"],
    ["RUB", "1100", "1199"],
    ["USD", "4.2", "4.99"],
    ["USD", "4.99", "4.99"],
    ["USD", "5", "5.99"],
    ["GRAM", "0.6923", "0.7"],
    ["GRAM", "0.12", "0.12"],
    ["USDT", "0.991", "1"],
  ] as const)("%s %s → %s", (code, amount, rounded) => {
    expect(roundPrice(amount, code).toString()).toBe(rounded);
  });

  it("всегда вверх: цена после пересчёта не ниже базовой", () => {
    for (const amount of ["0.001", "1.0001", "9.99", "123.456"]) {
      for (const code of ["XTR", "RUB", "USD", "GRAM"] as const) expect(roundPrice(amount, code).greaterThanOrEqualTo(amount)).toBe(true);
    }
    expect(() => roundPrice("0", "XTR")).toThrow(RangeError);
  });
});

describe("цена для способа оплаты", () => {
  it("звёзды, рубли и Gram — из одной базовой цены, по правилам своих валют", () => {
    const stars = priceFor(GEMS_SMALL, METHODS.stars as PaymentMethod, TODAY);
    const card = priceFor(GEMS_SMALL, METHODS.card as PaymentMethod, TODAY);
    const gram = priceFor(GEMS_SMALL, METHODS.gram as PaymentMethod, TODAY);

    // 0.99 $ / 0.013 = 76.15 → 77 ⭐; 0.99 × 84.6952 = 83.85 → 89 ₽, но минимум карты 100 → 109 ₽; 0.99 / 1.43 = 0.6923 → 0.70
    expect(stars).toMatchObject({ status: "available", amount: new Decimal(77), minor: 77n, from: "converted" });
    expect(card).toMatchObject({ status: "available", minor: 10900n });
    expect(card.status === "available" && card.amount.toString()).toBe("109");
    expect(gram.status === "available" && gram.minor).toBe(700_000_000n);
  });

  it("ручная цена побеждает пересчёт: ровно 50 звёзд при любом курсе", () => {
    const product: Product = { ...GEMS_SMALL, manual: { telegram_stars: "50" } };
    const cheap = snapshot("cheap", { XTR: "0.02" });
    expect(priceFor(product, METHODS.stars as PaymentMethod, TODAY)).toMatchObject({ amount: new Decimal(50), from: "manual" });
    expect(priceFor(product, METHODS.stars as PaymentMethod, cheap)).toMatchObject({ amount: new Decimal(50), from: "manual" });
  });

  it("вне пределов провайдера способ не предлагается, ручная цена ниже минимума — тоже", () => {
    const expensive: Product = { id: "whale", base: { currency: "USD", amount: "500" } };
    expect(priceFor(expensive, METHODS.stars as PaymentMethod, TODAY)).toEqual({ status: "unavailable", method: "telegram_stars", reason: "above_max" });
    expect(priceFor({ ...GEMS_SMALL, manual: { web_card_rub: "59" } }, METHODS.card as PaymentMethod, TODAY)).toEqual({ status: "unavailable", method: "web_card_rub", reason: "below_min" });
  });

  it("нет курса валюты способа — способ недоступен, а не цена ноль", () => {
    expect(priceFor(GEMS_SMALL, METHODS.gram as PaymentMethod, snapshot("no-gram", { XTR: "0.013" }))).toEqual({ status: "unavailable", method: "ton_gram", reason: "no_rate" });
  });
});

describe("прайс-лист не прыгает от каждого обновления курса", () => {
  const policy = { maxAgeMs: 24 * HOUR, jumpThreshold: "0.05" };
  const book = priceBook([GEMS_SMALL], Object.values(METHODS), TODAY, T0);

  it("помнит снимок, по которому посчитан", () => {
    expect(book.snapshotId).toBe("today");
    expect(book.prices.get("gems_small")?.size).toBe(3);
  });

  it("движение курса в пределах порога — цены стоят", () => {
    const moved = snapshot("moved", { RUB, GRAM: "1.48", XTR: "0.013" }, { XTR: "0.0105" });
    expect(needsReprice(book, TODAY, moved, new Date(T0.getTime() + HOUR), policy)).toBe(false);
  });

  it("скачок за порог, возраст, появление или пропажа курса — пересчёт", () => {
    const later = new Date(T0.getTime() + HOUR);
    expect(needsReprice(book, TODAY, snapshot("jump", { RUB, GRAM: "1.2", XTR: "0.013" }), later, policy)).toBe(true);
    expect(needsReprice(book, TODAY, TODAY, new Date(T0.getTime() + 24 * HOUR), policy)).toBe(true);
    expect(needsReprice(book, TODAY, snapshot("lost", { RUB, XTR: "0.013" }), later, policy)).toBe(true);
    expect(needsReprice(book, TODAY, snapshot("new", { RUB, GRAM: "1.43", XTR: "0.013", EUR: "1.138" }), later, policy)).toBe(true);
  });
});

describe("выручка по снимку платежа", () => {
  it("звёзды: оборот — по цене для игрока, выручка — по курсу выплаты", () => {
    const revenue = revenueOf({ amount: 77, method: METHODS.stars as PaymentMethod, snapshot: TODAY, reportCurrency: "USD" });
    expect(revenue.turnover.toString()).toBe("1.001");
    expect(revenue.revenue.toString()).toBe("0.8085");
    expect(revenue.snapshotId).toBe("today");
  });

  it("карта: комиссия внутри удерживается, сверху — нет; отчёт в рублях по курсу снимка", () => {
    const card = revenueOf({ amount: 109, method: METHODS.card as PaymentMethod, snapshot: TODAY, reportCurrency: "RUB" });
    expect(card.turnover.toDecimalPlaces(10).toString()).toBe("109");
    expect(card.revenue.toDecimalPlaces(10).toString()).toBe("105.73");

    const gram = revenueOf({ amount: "0.7", method: METHODS.gram as PaymentMethod, snapshot: TODAY, reportCurrency: "USD" });
    expect(gram.revenue.toString()).toBe("1.001");
  });

  it("без курса выплаты звёзд выручка не считается по цене покупки", () => {
    expect(() => revenueOf({ amount: 77, method: METHODS.stars as PaymentMethod, snapshot: snapshot("no-payout", { XTR: "0.013" }), reportCurrency: "USD" })).toThrow("нет курса XTR");
  });
});
