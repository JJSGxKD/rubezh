import { describe, expect, it } from "vitest";
import { formatCompact } from "../src/i18n";

// Короткая запись валют в шапке (docs/35-stage4-plan.md Р60, WP30): шапка
// обязана уместиться в 320 px при любом балансе, поэтому не больше пяти
// знаков, и округление вниз — не больше, чем у игрока есть.

const clean = (value: string): string => value.replace(/\s/g, " ");

describe("короткая запись чисел", () => {
  it("до 9 999 — целиком, с разрядами", () => {
    expect(clean(formatCompact(0))).toBe("0");
    expect(clean(formatCompact(999))).toBe("999");
    expect(clean(formatCompact(9_999))).toBe("9 999");
  });

  it("дальше — три значащие цифры с единицей, округление вниз", () => {
    expect(formatCompact(10_000)).toBe("10К");
    expect(formatCompact(12_345)).toBe("12,3К");
    expect(formatCompact(99_999)).toBe("99,9К");
    expect(formatCompact(100_000)).toBe("100К");
    expect(formatCompact(999_999)).toBe("999К");
    expect(formatCompact(1_000_000)).toBe("1М");
    expect(formatCompact(1_239_000)).toBe("1,23М");
    expect(formatCompact(9_999_999)).toBe("9,99М");
    expect(formatCompact(123_456_789)).toBe("123М");
    expect(formatCompact(4_560_000_000)).toBe("4,56Б");
  });

  it("не длиннее пяти знаков — столько помещается в шапке на 320 px", () => {
    for (const value of [9_999, 10_001, 55_555, 99_999, 555_555, 999_999, 5_555_555, 99_999_999, 999_999_999]) {
      expect(clean(formatCompact(value)).length, String(value)).toBeLessThanOrEqual(5);
    }
  });

  it("мусор из хранилища и отрицательное — ноль, а не NaN", () => {
    expect(formatCompact(Number.NaN)).toBe("0");
    expect(formatCompact(-5)).toBe("0");
    expect(formatCompact(12.9)).toBe("12");
  });
});
