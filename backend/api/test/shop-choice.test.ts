import { describe, expect, it } from "vitest";
import { SHOP_SKUS } from "../src/modules/shop/shop-catalog.js";
import { choiceOf } from "../src/modules/shop/shop-choice.js";

/** «Выбор игроков» (docs/35-stage4-plan.md, Р162): чистое правило выбора набора по числу разных покупателей. */
describe("выбор игроков — чистое правило", () => {
  it("лидер с 25 покупателями при пороге 20 получает метку, с 19 — нет", () => {
    expect(choiceOf(new Map([["gems_330", 25]]), SHOP_SKUS, 20)).toBe("gems_330");
    expect(choiceOf(new Map([["gems_330", 20]]), SHOP_SKUS, 20)).toBe("gems_330");
    expect(choiceOf(new Map([["gems_330", 19]]), SHOP_SKUS, 20)).toBeNull();
  });

  it("лидер — набор с наибольшим числом покупателей", () => {
    expect(
      choiceOf(
        new Map([
          ["gems_60", 30],
          ["gems_330", 41],
          ["gems_700", 22],
        ]),
        SHOP_SKUS,
        20,
      ),
    ).toBe("gems_330");
  });

  it("ничья — у набора с меньшим sort", () => {
    expect(
      choiceOf(
        new Map([
          ["gems_700", 30],
          ["gems_60", 30],
          ["gems_330", 30],
        ]),
        SHOP_SKUS,
        20,
      ),
    ).toBe("gems_60");
  });

  it("разовый набор не участвует, даже если его купили больше всех", () => {
    expect(
      choiceOf(
        new Map([
          ["starter", 500],
          ["gems_60", 21],
        ]),
        SHOP_SKUS,
        20,
      ),
    ).toBe("gems_60");
    expect(choiceOf(new Map([["starter", 500]]), SHOP_SKUS, 20)).toBeNull();
  });

  it("набор вне переданных (не продаётся сейчас) не участвует", () => {
    const sellable = SHOP_SKUS.filter((sku) => sku.id !== "gems_330");
    expect(
      choiceOf(
        new Map([
          ["gems_330", 90],
          ["gems_700", 21],
        ]),
        sellable,
        20,
      ),
    ).toBe("gems_700");
  });

  it("нет покупок — метки нет, даже при нулевом пороге", () => {
    expect(choiceOf(new Map(), SHOP_SKUS, 20)).toBeNull();
    expect(choiceOf(new Map(), SHOP_SKUS, 0)).toBeNull();
  });
});
