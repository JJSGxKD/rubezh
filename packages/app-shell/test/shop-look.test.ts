import { describe, expect, it } from "vitest";
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
