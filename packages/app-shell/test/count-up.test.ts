import { describe, expect, it } from "vitest";
import { COUNT_UP_MS, countUpValue } from "../src/screens/count-up-rules";

// Счётчик награды набегает (design/art/effects.md §6, F-07): «+88» досчитывается
// от прежнего значения, а не появляется готовым — награду видно растущей.

describe("набегающий счётчик", () => {
  it("начинает с прежнего значения и кончается ровно на итоговом", () => {
    expect(countUpValue(0, 88, 0)).toBe(0);
    expect(countUpValue(0, 88, COUNT_UP_MS)).toBe(88);
    expect(countUpValue(0, 88, COUNT_UP_MS * 3)).toBe(88);
    expect(countUpValue(88, 176, 0)).toBe(88);
  });

  it("только целые и не убывает", () => {
    let previous = 0;
    for (let ms = 0; ms <= COUNT_UP_MS; ms += 16) {
      const value = countUpValue(0, 1234, ms);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("быстро в начале, медленно у итога: последние числа успевают прочитаться", () => {
    expect(countUpValue(0, 100, COUNT_UP_MS / 2)).toBeGreaterThan(60);
  });
});
