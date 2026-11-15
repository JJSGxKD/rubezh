import { describe, expect, it } from "vitest";
import { formatMinor, toMinor, type CurrencySpec } from "../src/money.js";

const XTR: CurrencySpec = { code: "XTR", decimals: 0 };
const RUB: CurrencySpec = { code: "RUB", decimals: 2 };
const GRAM: CurrencySpec = { code: "GRAM", decimals: 9 };
const WEI: CurrencySpec = { code: "WEI", decimals: 18 };

describe("toMinor", () => {
  it("переводит десятичную строку в минимальные единицы", () => {
    expect(toMinor("12.34", RUB)).toBe(1234n);
    expect(toMinor("1", GRAM)).toBe(1_000_000_000n);
    expect(toMinor("100", XTR)).toBe(100n);
  });

  it("понимает знак и дробь без целой части", () => {
    expect(toMinor("-0.5", RUB)).toBe(-50n);
    expect(toMinor("−0.5", RUB)).toBe(-50n);
    expect(toMinor("+7", RUB)).toBe(700n);
    expect(toMinor(".5", RUB)).toBe(50n);
  });

  it("не округляет молча: лишние знаки — исключение", () => {
    expect(() => toMinor("0.1234", RUB)).toThrow();
    expect(() => toMinor("1.5", XTR)).toThrow();
  });

  it("допускает хвост из нулей сверх знаков валюты", () => {
    expect(toMinor("1.500", RUB)).toBe(150n);
  });

  it("отвергает мусор", () => {
    for (const bad of ["abc", "", " ", "1.2.3", "1e5", "--1", "1,5", "NaN", "."]) {
      expect(() => toMinor(bad, RUB), bad).toThrow();
    }
  });

  it("не теряет точность на больших числах", () => {
    expect(toMinor("123456789012345678.123456789012345678", WEI)).toBe(123456789012345678123456789012345678n);
  });

  it("отвергает неверное число знаков в справочнике", () => {
    expect(() => toMinor("1", { code: "X", decimals: -1 })).toThrow();
    expect(() => toMinor("1", { code: "X", decimals: 19 })).toThrow();
    expect(() => toMinor("1", { code: "X", decimals: 1.5 })).toThrow();
  });
});

describe("formatMinor", () => {
  it("выводит обратно без потери точности", () => {
    expect(formatMinor(1234n, RUB)).toBe("12.34");
    expect(formatMinor(0n, RUB)).toBe("0.00");
    expect(formatMinor(0n, XTR)).toBe("0");
    expect(formatMinor(50n, XTR)).toBe("50");
    expect(formatMinor(5n, RUB)).toBe("0.05");
  });

  it("держит знак у отрицательных", () => {
    expect(formatMinor(-5n, GRAM)).toBe("-0.000000005");
    expect(formatMinor(-1234n, RUB)).toBe("-12.34");
  });

  it("работает с 18 знаками", () => {
    expect(formatMinor(1n, WEI)).toBe("0.000000000000000001");
    expect(formatMinor(10n ** 18n, WEI)).toBe("1.000000000000000000");
  });

  it("круговое преобразование на наборе значений", () => {
    const amounts = [0n, 1n, -1n, 99n, -99n, 100n, 123_456_789n, -987_654_321_012n, 10n ** 30n];
    for (const spec of [XTR, RUB, GRAM, WEI]) {
      for (const amount of amounts) {
        expect(toMinor(formatMinor(amount, spec), spec), `${spec.code} ${amount}`).toBe(amount);
      }
    }
  });
});
