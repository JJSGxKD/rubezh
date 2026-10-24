import { describe, expect, it } from "vitest";
import { COIN_PILE_MAX, coinPile, PILE_SPOTS } from "../src/screens/meta/daily-pile";

// Награда дня — вещью, а не числом (design/art/ui-ux.md, U-12): горсть монет
// растёт по дням недели, и рост виден до того, как прочитаешь число.

const week = [60, 80, 100, 120, 150, 200, 400];

describe("горсть монет награды дня", () => {
  it("самый скромный день — одна монета, самый щедрый — полная горсть", () => {
    expect(coinPile(60, week)).toBe(1);
    expect(coinPile(400, week)).toBe(COIN_PILE_MAX);
  });

  it("горсть не убывает с наградой", () => {
    const piles = week.map((coins) => coinPile(coins, week));
    for (let i = 1; i < piles.length; i++) expect(piles[i] ?? 0).toBeGreaterThanOrEqual(piles[i - 1] ?? 0);
  });

  it("равные награды — равные горсти; ровная неделя — по одной монете", () => {
    expect(coinPile(100, [100, 100, 100])).toBe(1);
    expect(coinPile(0, [])).toBe(1);
  });

  it("на каждый размер горсти есть раскладка, монеты не выходят за плитку", () => {
    for (let size = 1; size <= COIN_PILE_MAX; size++) {
      const spots = PILE_SPOTS[size - 1] ?? [];
      expect(spots).toHaveLength(size);
      for (const [x, y] of spots) {
        expect(Math.abs(x)).toBeLessThanOrEqual(13);
        expect(Math.abs(y)).toBeLessThanOrEqual(8);
      }
    }
  });
});
