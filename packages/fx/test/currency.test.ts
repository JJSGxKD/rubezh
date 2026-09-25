import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  CURRENCY_CODES,
  currency,
  findCurrencyProblems,
  fromMinorUnits,
  isCurrencyCode,
  REFERENCE_CURRENCY,
  resolveCurrencyCode,
  type Currency,
} from "../src/currency.js";

// Реестр валют — данные (docs/35-stage4-plan.md §3.12, Р35). Тест ловит
// опечатку в разрядности раньше, чем она превратит 10 Gram в 10 нанотонов.

describe("реестр валют", () => {
  it("описывает ровно валюты старта и проходит проверку", () => {
    expect([...CURRENCY_CODES].sort()).toEqual(["EUR", "GRAM", "RUB", "USD", "USDT", "XTR"]);
    expect(CURRENCIES.map((entry) => entry.code).sort()).toEqual([...CURRENCY_CODES].sort());
    expect(findCurrencyProblems(CURRENCIES)).toEqual([]);
  });

  it("держит разрядности из плана: рубль 2, Gram 9, USDT 6, звёзды 0", () => {
    expect(currency("RUB").decimals).toBe(2);
    expect(currency("GRAM").decimals).toBe(9);
    expect(currency("USDT").decimals).toBe(6);
    expect(currency("XTR").decimals).toBe(0);
    expect(currency(REFERENCE_CURRENCY).kind).toBe("fiat");
  });

  it("знает, что Gram раньше назывался TON, и не путает с посторонним", () => {
    expect(resolveCurrencyCode("TON")).toBe("GRAM");
    expect(resolveCurrencyCode("GRAM")).toBe("GRAM");
    expect(resolveCurrencyCode("BTC")).toBeNull();
    expect(isCurrencyCode("ton")).toBe(false);
  });

  it("переводит минорные единицы по разрядности валюты", () => {
    expect(fromMinorUnits(12345n, "RUB").toString()).toBe("123.45");
    expect(fromMinorUnits(1_500_000_000n, "GRAM").toString()).toBe("1.5");
    expect(fromMinorUnits(50n, "XTR").toString()).toBe("50");
    expect(() => currency("BTC" as never)).toThrow(/неизвестная валюта/);
  });

  it("называет валюту и поле в ошибке реестра", () => {
    const broken: Currency[] = [
      ...CURRENCIES,
      { code: "RUB", kind: "fiat", decimals: 99, nameKey: "", formerCodes: ["USD"] },
      { code: "XTR", kind: "platform", decimals: 0, nameKey: "x", formerCodes: [] },
      { code: "USDT", kind: "crypto", decimals: 6, nameKey: "x", formerCodes: [], platform: "vk" },
    ];
    const problems = findCurrencyProblems(broken);
    expect(problems).toContain("валюта RUB: код повторяется");
    expect(problems).toContain("валюта RUB: разрядность 99 вне 0..18");
    expect(problems).toContain("валюта RUB: нет ключа имени");
    expect(problems).toContain("валюта RUB: прежний код USD занят действующей валютой");
    expect(problems).toContain("валюта XTR: валюта площадки без площадки");
    expect(problems).toContain("валюта USDT: площадка указана у валюты не площадки");
    expect(findCurrencyProblems(CURRENCIES.filter((entry) => entry.code !== "USD"))).toContain("опорной валюты USD нет в реестре");
  });
});
