import { describe, expect, it } from "vitest";
import { statChange, statValue } from "../src/screens/meta/arsenal-parts";

/**
 * «Было → стало» в листе предмета (T-0187). Малая прибавка от улучшения на
 * одном знаке после запятой съедается округлением, и строка врала бы
 * «+0,2 → +0,2»; здесь проверяется, что разница видна, а неизменное свойство
 * показывается одним значением.
 */

describe("statChange", () => {
  it("на одном знаке совпадает — показывает два знака", () => {
    expect(statChange("regenPerSec", 0.2, 0.24)).toEqual({ from: "+0,2", to: "+0,24" });
  });

  it("разница видна на одном знаке — показывает один знак", () => {
    expect(statChange("regenPerSec", 0.2, 0.5)).toEqual({ from: "+0,2", to: "+0,5" });
  });

  it("проценты: на одном знаке — как печатает formatDecimal", () => {
    expect(statChange("moveSpeed", 0.038, 0.04)).toEqual({ from: "+3,8%", to: "+4%" });
  });

  it("проценты: малая прибавка видна на двух знаках", () => {
    expect(statChange("resistCold", 0.039, 0.0392)).toEqual({ from: "+3,9%", to: "+3,92%" });
  });

  it("неразличимо и на двух знаках — to: null, строка показывает одно значение", () => {
    expect(statChange("armor", 2, 2.001)).toEqual({ from: "+2", to: null });
  });

  it("совпадающие значения — to: null", () => {
    expect(statChange("maxHp", 30, 30)).toEqual({ from: "+30", to: null });
  });
});

describe("statValue", () => {
  it("без третьего аргумента печатает как раньше — один знак", () => {
    expect(statValue("regenPerSec", 0.2)).toBe("+0,2");
    expect(statValue("moveSpeed", 0.038)).toBe("+3,8%");
  });

  it("с двумя знаками печатает точнее", () => {
    expect(statValue("regenPerSec", 0.24, 2)).toBe("+0,24");
    expect(statValue("resistCold", 0.0392, 2)).toBe("+3,92%");
  });
});
