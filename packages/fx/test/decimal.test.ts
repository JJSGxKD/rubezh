import { describe, expect, it } from "vitest";
import { Decimal, DecimalError } from "../src/decimal.js";

// Decimal — основа курсов и цен (docs/35-stage4-plan.md §3.12). Проверяется
// не арифметика вообще, а то, где деньги теряются: сложение дробей, режимы
// округления на половинках и отрицательных, минорные единицы, числа за
// пределами точности float.

describe("разбор", () => {
  it("читает целые, дроби, знак и экспоненту", () => {
    expect(Decimal.of("1").toString()).toBe("1");
    expect(Decimal.of("1.50").toString()).toBe("1.5");
    expect(Decimal.of("-0.001").toString()).toBe("-0.001");
    expect(Decimal.of("1.5e-7").toString()).toBe("0.00000015");
    expect(Decimal.of("12.5e2").toString()).toBe("1250");
    expect(Decimal.of(" 3 ").toString()).toBe("3");
    expect(Decimal.of("+7.25").toString()).toBe("7.25");
    expect(Decimal.of("0.000").toString()).toBe("0");
    expect(Decimal.of("-0").toString()).toBe("0");
  });

  it("принимает число из JSON и bigint", () => {
    expect(Decimal.of(3.21).toString()).toBe("3.21");
    expect(Decimal.of(1e-7).toString()).toBe("0.0000001");
    expect(Decimal.of(123456789012345678901234567890n).toString()).toBe("123456789012345678901234567890");
  });

  it.each(["", "1,5", "abc", "1.2.3", "1e", ".5", "5.", "1e500"])("отвергает «%s»", (text) => {
    expect(() => Decimal.of(text)).toThrow(DecimalError);
  });

  it("отвергает NaN и бесконечность", () => {
    expect(() => Decimal.of(Number.NaN)).toThrow(DecimalError);
    expect(() => Decimal.of(Number.POSITIVE_INFINITY)).toThrow(DecimalError);
  });
});

describe("арифметика", () => {
  it("складывает дроби без ошибки плавающей точки", () => {
    expect(Decimal.of("0.1").add("0.2").eq("0.3")).toBe(true);
    expect(Decimal.of("0.1").add("0.2").toString()).toBe("0.3");
  });

  it("умножает точно и не округляет", () => {
    expect(Decimal.of("1.1").mul("1.1").toString()).toBe("1.21");
    expect(Decimal.of("92.1234").mul("0.010855").toString()).toBe("0.999999507");
    // Курс в 18 знаках, умноженный на сумму, остаётся точным
    const rate = Decimal.ONE.div("92.1234", 18);
    expect(rate.toString()).toBe("0.010855005351517638");
    expect(Decimal.of("1000").mul(rate).toString()).toBe("10.855005351517638");
  });

  it("не теряет знаки за пределами double", () => {
    const big = Decimal.of("9007199254740993");
    expect(big.add(1).toString()).toBe("9007199254740994");
    expect(big.mul(big).toString()).toBe(String(9007199254740993n * 9007199254740993n));
  });

  it("вычитает и меняет знак", () => {
    expect(Decimal.of("1").sub("1.25").toString()).toBe("-0.25");
    expect(Decimal.of("-0.25").abs().toString()).toBe("0.25");
    expect(Decimal.of("0.25").neg().toString()).toBe("-0.25");
  });

  it("делит с заданным числом знаков", () => {
    expect(Decimal.ONE.div(3, 2).toString()).toBe("0.33");
    expect(Decimal.of(2).div(3, 2).toString()).toBe("0.67");
    expect(Decimal.of(10).div(4, 0).toString()).toBe("3");
    expect(Decimal.of(10).div(4, 0, "half_even").toString()).toBe("2");
    expect(Decimal.of("1e-9").div("3", 12).toString()).toBe("0.000000000333");
  });

  it("не делит на ноль и не принимает дробное число знаков", () => {
    expect(() => Decimal.ONE.div(0, 2)).toThrow(DecimalError);
    expect(() => Decimal.ONE.div(3, 1.5)).toThrow(DecimalError);
    expect(() => Decimal.ONE.round(-1)).toThrow(DecimalError);
  });

  it("сдвигает на степень десяти точно в обе стороны", () => {
    expect(Decimal.of("1.5").shift(3).toString()).toBe("1500");
    expect(Decimal.of("1500").shift(-3).toString()).toBe("1.5");
  });
});

describe("округление", () => {
  it.each([
    ["2.5", "half_up", "3"],
    ["-2.5", "half_up", "-3"],
    ["2.5", "half_even", "2"],
    ["3.5", "half_even", "4"],
    ["-2.5", "half_even", "-2"],
    ["2.4", "half_up", "2"],
    ["2.6", "down", "2"],
    ["-2.6", "down", "-2"],
    ["2.1", "up", "3"],
    ["-2.1", "up", "-3"],
    ["2.1", "ceil", "3"],
    ["-2.1", "ceil", "-2"],
    ["2.9", "floor", "2"],
    ["-2.1", "floor", "-3"],
  ] as const)("%s → %s = %s", (value, mode, expected) => {
    expect(Decimal.of(value).round(0, mode).toString()).toBe(expected);
  });

  it("не трогает число, у которого знаков меньше", () => {
    expect(Decimal.of("1.5").round(4).toString()).toBe("1.5");
  });

  it("считает минорные единицы", () => {
    expect(Decimal.of("123.456").toMinor(2)).toBe(12346n);
    expect(Decimal.of("123.455").toMinor(2, "half_even")).toBe(12346n);
    expect(Decimal.of("123.445").toMinor(2, "half_even")).toBe(12344n);
    expect(Decimal.of("0.5").toMinor(0)).toBe(1n);
    expect(Decimal.of("-0.005").toMinor(2)).toBe(-1n);
    expect(Decimal.of("7").toMinor(9)).toBe(7_000_000_000n);
    expect(Decimal.fromMinor(12345n, 2).toString()).toBe("123.45");
  });
});

describe("сравнение и вывод", () => {
  it("сравнивает по значению, а не по записи", () => {
    expect(Decimal.of("1.50").eq("1.5")).toBe(true);
    expect(Decimal.of("1.5").lt("1.51")).toBe(true);
    expect(Decimal.of("-1").lt("0")).toBe(true);
    expect(Decimal.of("2").gte("2")).toBe(true);
    expect(Decimal.of("2").gt("2")).toBe(false);
    expect(Decimal.of("0").isZero()).toBe(true);
    expect(Decimal.of("-0.1").isNegative()).toBe(true);
    expect(Decimal.of("0.1").isPositive()).toBe(true);
  });

  it("находит минимум и максимум", () => {
    expect(Decimal.min(Decimal.of(3), Decimal.of("2.5"), Decimal.of(9)).toString()).toBe("2.5");
    expect(Decimal.max(Decimal.of(3), Decimal.of("2.5"), Decimal.of(9)).toString()).toBe("9");
  });

  it("печатает без экспоненты и с нужным числом знаков", () => {
    expect(Decimal.of("1e-9").toString()).toBe("0.000000001");
    expect(Decimal.of("5").toFixed(2)).toBe("5.00");
    expect(Decimal.of("0.5").toFixed(2)).toBe("0.50");
    expect(Decimal.of("-0.125").toFixed(2)).toBe("-0.13");
    expect(Decimal.of("2.5").toFixed(0)).toBe("3");
    expect(JSON.stringify({ rate: Decimal.of("0.10") })).toBe('{"rate":"0.1"}');
    expect(Decimal.of("0.1").toNumber()).toBe(0.1);
  });
});
