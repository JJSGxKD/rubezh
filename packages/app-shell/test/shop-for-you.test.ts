import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ItemCard } from "../src/screens/meta/shop-parts";
import type { ShopItem } from "../src/state/shop-api";

// «Подобрано для тебя» (Р211): кнопка покупки — обычная, как у VIP и наборов;
// выделяют карточку срез угла и метка «Один раз», а не золотой срез кнопки.

const STARTER = {
  sku: "starter",
  kind: "starter",
  contents: [
    { resource: "coins", amount: 3000 },
    { resource: "gems", amount: 60 },
  ],
  stars: 50,
  chargedStars: 50,
  once: true,
  owned: false,
} as unknown as ShopItem;

function card(forYou: boolean): string {
  return renderToStaticMarkup(createElement(ItemCard, { item: STARTER, index: 0, busy: null, now: 0, forYou, onBuy: () => undefined }));
}

describe("«Подобрано для тебя»", () => {
  it("с forYou — срез угла у карточки, нет среза у кнопки звёзд, есть метка «Один раз»", () => {
    const html = card(true);

    expect(html).toContain("cut-frame");
    expect(html).not.toContain("cut-stars");
    expect(html).toContain("Один раз");
  });

  it("без forYou — нет ни среза карточки, ни среза кнопки звёзд", () => {
    const html = card(false);

    expect(html).not.toContain("cut-frame");
    expect(html).not.toContain("cut-stars");
  });
});
