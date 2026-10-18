import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../src/design-system/components";
import { gemPileSize } from "../src/screens/meta/shop-look";

// Горсть самоцветов на плитке набора: растёт с размером набора среди наборов
// самоцветов (design/screens/shop.html, «Плитки самоцветов»).

describe("размер горсти самоцветов", () => {
  it("три набора: малый — один значок, средний — три, большой — пять", () => {
    const packs = [60, 330, 700];

    expect(gemPileSize(60, packs)).toBe(1);
    expect(gemPileSize(330, packs)).toBe(3);
    expect(gemPileSize(700, packs)).toBe(5);
  });

  it("единственный набор — три", () => {
    expect(gemPileSize(100, [100])).toBe(3);
  });

  it("четыре набора: крайние — 1 и 5, средние — 3", () => {
    const packs = [60, 150, 330, 700];

    expect(gemPileSize(60, packs)).toBe(1);
    expect(gemPileSize(150, packs)).toBe(3);
    expect(gemPileSize(330, packs)).toBe(3);
    expect(gemPileSize(700, packs)).toBe(5);
  });

  it("порядок наборов в массиве не важен", () => {
    const packs = [700, 60, 330];

    expect(gemPileSize(60, packs)).toBe(1);
    expect(gemPileSize(330, packs)).toBe(3);
    expect(gemPileSize(700, packs)).toBe(5);
  });
});

// Срез у кнопки звёзд: главная покупка магазина (design/screens/shop.html).
// Остальные варианты, кроме главной кнопки, по-прежнему без среза.

function button(props: { variant: "stars" | "secondary"; cut?: boolean }): string {
  const children: ReactNode = "50";
  return renderToStaticMarkup(createElement(Button, { ...props, children }));
}

describe("срез у кнопки звёзд", () => {
  it("stars с cut — срез тона звёзд вместо плоской кнопки", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const html = button({ variant: "stars", cut: true });

    expect(html).toContain("cut-frame");
    expect(html).toContain("cut-stars");
    expect(html).not.toContain("btn-stars");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stars без cut — как раньше", () => {
    const html = button({ variant: "stars" });

    expect(html).toContain("btn-stars");
    expect(html).not.toContain("cut-frame");
  });
});
