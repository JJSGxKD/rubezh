import { describe, expect, it } from "vitest";
import { BOSS_RADIUS_MUL, ELITE_RADIUS_MUL } from "../src/game/patterns";
import { laneWidth } from "../src/game/render/telegraphs";

// Полоса рывка (design/art/direction-v2.md §5.1, T-0197): шириной с тело
// врага. Полоса тоньше тела обещала бы безопасность там, где рывок ещё бьёт:
// у Тарана радиус 24 единицы, а прежняя полоса была шириной 10.

describe("ширина полосы рывка", () => {
  it("равна диаметру тела", () => {
    expect(laneWidth(10)).toBe(20);
    expect(laneWidth(0)).toBe(0);
  });

  it("у элиты и босса шире, чем у рядового, ровно во столько, во сколько крупнее тело", () => {
    const normal = laneWidth(10);
    expect(laneWidth(10 * ELITE_RADIUS_MUL) / normal).toBeCloseTo(ELITE_RADIUS_MUL);
    expect(laneWidth(10 * BOSS_RADIUS_MUL) / normal).toBeCloseTo(BOSS_RADIUS_MUL);
  });
});
