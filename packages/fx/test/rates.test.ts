import { describe, expect, it } from "vitest";
import { Decimal, decimal, positive } from "../src/decimal.js";
import { manualRate, manualToRate } from "../src/manual.js";
import { quoteFromUnitsPerUsd, quotesViaHome } from "../src/quote.js";
import {
  MissingRateError,
  convert,
  crossRate,
  fromMinorUnits,
  payoutUsdPerUnit,
  rateOf,
  toMinorUnits,
  type Rate,
  type RatesSnapshot,
} from "../src/rates.js";
import type { CurrencyCode } from "../src/currencies.js";

/**
 * Пересчёт и приведение котировок (docs/35-stage4-plan.md, WP9). Главное —
 * одно соглашение о курсе и `Decimal` без потери точности: у источника
 * (`vpnsibcom_api`, `fx.util.ts`) два соглашения и `Float` уже однажды дали
 * ошибку пересчёта.
 */

const AT = new Date("2026-09-25T12:00:00Z");

function snapshot(rates: Partial<Record<CurrencyCode, string>>, payout: Partial<Record<CurrencyCode, string>> = {}): RatesSnapshot {
  const toMap = (entries: Partial<Record<CurrencyCode, string>>) =>
    new Map(Object.entries(entries).map(([code, usd]) => [code as CurrencyCode, rateOf(code as CurrencyCode, usd as string, ["test"], AT)] as [CurrencyCode, Rate]));
  return { id: "s1", takenAt: AT, rates: toMap(rates), payout: toMap(payout) };
}

// 1 USD = 92.5 RUB, 1 EUR = 1.08 USD, 1 GRAM = 5.2 USD, 1 звезда = 0.013 USD покупателю
const SNAPSHOT = snapshot({ RUB: new Decimal(1).div("92.5").toString(), EUR: "1.08", GRAM: "5.2", USDT: "1", XTR: "0.013" }, { XTR: "0.0105" });

describe("пересчёт по снимку", () => {
  it("идёт через опорную валюту и не теряет точность на цепочке", () => {
    const gram = convert("1000", "RUB", "GRAM", SNAPSHOT);
    // 1000 ₽ → 10.8108… $ → 2.0790… GRAM; обратно — ровно 1000 ₽ в пределах 40 знаков
    expect(gram.toFixed(9)).toBe("2.079002079");
    expect(convert(gram, "GRAM", "RUB", SNAPSHOT).toDecimalPlaces(20).toString()).toBe("1000");
  });

  it("0.1 + 0.2 — это 0.3: суммы не проходят через двоичную дробь", () => {
    expect(decimal(0.1).plus(decimal(0.2)).toString()).toBe("0.3");
    expect(convert(0.1, "USD", "EUR", SNAPSHOT).mul("1.08").toDecimalPlaces(30).toString()).toBe("0.1");
  });

  it("одна и та же валюта — без пересчёта и без курса", () => {
    expect(convert("42.5", "XTR", "XTR", snapshot({})).toString()).toBe("42.5");
  });

  it("курс для человека — сколько рублей за одну Gram", () => {
    expect(crossRate("GRAM", "RUB", SNAPSHOT).toDecimalPlaces(30).toString()).toBe("481");
  });

  it("нет курса — ошибка с названием валюты, а не ноль", () => {
    expect(() => convert(1, "EUR", "RUB", snapshot({ EUR: "1.08" }))).toThrow(MissingRateError);
    expect(() => convert(1, "EUR", "RUB", snapshot({ EUR: "1.08" }))).toThrow("нет курса RUB");
  });

  it("выручка со звёзд — по курсу выплаты, а не по цене для игрока", () => {
    expect(payoutUsdPerUnit(SNAPSHOT, "XTR").toString()).toBe("0.0105");
    expect(() => payoutUsdPerUnit(snapshot({ XTR: "0.013" }), "XTR")).toThrow(MissingRateError);
    // у фиата и крипты выплата и цена — одно число
    expect(payoutUsdPerUnit(SNAPSHOT, "GRAM").toString()).toBe("5.2");
  });

  it("курс ноль или меньше не заводится вовсе", () => {
    expect(() => rateOf("EUR", "0", ["test"], AT)).toThrow(RangeError);
    expect(() => rateOf("EUR", "-1.08", ["test"], AT)).toThrow(RangeError);
  });
});

describe("минорные единицы и округление", () => {
  it.each([
    ["XTR", "49.5", "half_up", 50n],
    ["XTR", "49.4999", "half_up", 49n],
    ["XTR", "49.01", "up", 50n],
    ["XTR", "49.99", "down", 49n],
    ["RUB", "199.005", "half_up", 19901n],
    ["RUB", "199.004", "half_up", 19900n],
    ["RUB", "0.001", "up", 1n],
    ["GRAM", "2.0790020790", "half_up", 2079002079n],
    ["GRAM", "0.0000000005", "half_up", 1n],
    ["GRAM", "0.0000000004", "half_up", 0n],
    ["USDT", "1.0000005", "half_up", 1000001n],
  ] as const)("%s %s (%s) → %s", (code, amount, rounding, minor) => {
    expect(toMinorUnits(amount, code, rounding)).toBe(minor);
  });

  it("обратно — без потерь", () => {
    expect(fromMinorUnits(2079002079n, "GRAM").toString()).toBe("2.079002079");
    expect(fromMinorUnits(19901n, "RUB").toString()).toBe("199.01");
    expect(fromMinorUnits(50n, "XTR").toString()).toBe("50");
  });
});

describe("приведение котировок источника", () => {
  it("цены в рублях (ЦБ) — через цену доллара, и рубль получает свой курс", () => {
    const quotes = quotesViaHome({
      home: "RUB",
      prices: new Map([
        ["USD", "92.5"],
        ["EUR", "99.9"],
      ]),
      source: "cbr",
      observedAt: AT,
    });
    const byCode = new Map(quotes.map((quote) => [quote.currency, quote.usdPerUnit.toString()]));

    expect(byCode.get("EUR")).toBe("1.08");
    expect(new Decimal(byCode.get("RUB") ?? "0").mul("92.5").toDecimalPlaces(30).toString()).toBe("1");
    expect(byCode.has("USD")).toBe(false);
  });

  it("без цены доллара или с нулём ответ отвергается целиком", () => {
    expect(() => quotesViaHome({ home: "RUB", prices: new Map([["EUR", "99.9"]]), source: "cbr", observedAt: AT })).toThrow(/нет цены доллара/);
    expect(() => quotesViaHome({ home: "RUB", prices: new Map([["USD", "0"]]), source: "cbr", observedAt: AT })).toThrow(RangeError);
    expect(() =>
      quotesViaHome({
        home: "EUR",
        prices: new Map([
          ["USD", "1.08"],
          ["RUB", "не число"],
        ]),
        source: "ecb",
        observedAt: AT,
      }),
    ).toThrow(RangeError);
  });

  it("«единиц за доллар» разворачивается один раз, в адаптере", () => {
    expect(quoteFromUnitsPerUsd("XTR", "76.923076923076923077", "fragment", AT).usdPerUnit.toDecimalPlaces(6).toString()).toBe("0.013");
  });
});

describe("числа с границы", () => {
  it("JSON-число берётся кратчайшей записью, не двоичным значением", () => {
    expect(decimal(5.23).toString()).toBe("5.23");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, "abc", ""])("%s — не число", (value) => {
    expect(() => positive(value, "курс")).toThrow(RangeError);
  });
});

describe("заданный курс площадки", () => {
  it("живёт в срок годности и без него не заводится", () => {
    const setAt = new Date("2026-09-25T00:00:00Z");
    expect(() => manualRate({ currency: "XTR", purpose: "price", price: "0.013", setBy: "a1", setAt, expiresAt: setAt, note: "" })).toThrow(RangeError);
    expect(() => manualRate({ currency: "XTR", purpose: "price", price: "0", setBy: "a1", setAt, expiresAt: new Date("2026-10-25T00:00:00Z"), note: "" })).toThrow(RangeError);

    const rate = manualToRate(manualRate({ currency: "XTR", purpose: "payout", price: "0.013", setBy: "a1", setAt, expiresAt: new Date("2026-10-25T00:00:00Z"), note: "вывод" }), new Decimal(1));
    expect(rate).toMatchObject({ currency: "XTR", sources: ["manual:a1"], observedAt: new Date("2026-10-25T00:00:00Z") });
    expect(rate.usdPerUnit.toString()).toBe("0.013");
  });

  it("цена в рублях переводится в доллары по курсу рубля (Р37)", () => {
    const setAt = new Date("2026-09-25T00:00:00Z");
    const rate = manualRate({ currency: "XTR", purpose: "price", price: "1.72", quote: "RUB", setBy: "a1", setAt, expiresAt: new Date("2026-12-25T00:00:00Z"), note: "прайс-лист клиента" });
    const converted = manualToRate(rate, new Decimal(1).div("84.6952"));
    expect(converted.usdPerUnit.toDecimalPlaces(5).toString()).toBe("0.02031");
    expect(converted.sources).toEqual(["manual:a1", "via:RUB"]);
  });

  it("котировка в валюте площадки запрещена: у неё самой нет рынка", () => {
    const setAt = new Date("2026-09-25T00:00:00Z");
    expect(() => manualRate({ currency: "XTR", purpose: "price", price: "1", quote: "XTR", setBy: "a1", setAt, expiresAt: new Date("2026-12-25T00:00:00Z"), note: "" })).toThrow(/нет рынка/);
  });
});
