import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HERO_PORTRAIT_URL, heroPortrait } from "../src/screens/meta/hero-portrait";

describe("портрет героя в арсенале", () => {
  it("только за флагом «Черновой арт» и в режиме разработчика", () => {
    expect(heroPortrait(false, false)).toBeNull();
    expect(heroPortrait(true, false)).toBeNull();
    expect(heroPortrait(false, true)).toBeNull();
    expect(heroPortrait(true, true)).toBe(HERO_PORTRAIT_URL);
  });

  it("портрет собран и обрезан по кадру: рамка внутри ячейки атласа", () => {
    const file = fileURLToPath(HERO_PORTRAIT_URL);
    expect(existsSync(file), "node design/art/src/portraits.mjs").toBe(true);
    const viewBox = /viewBox="([^"]+)"/.exec(readFileSync(file, "utf8"))?.[1]?.split(" ").map(Number) ?? [];
    expect(viewBox).toHaveLength(4);
    const [x = 0, y = 0, w = 0, h = 0] = viewBox;
    expect(x).toBeGreaterThanOrEqual(-50);
    expect(y).toBeGreaterThanOrEqual(-50);
    expect(x + w).toBeLessThanOrEqual(50.1);
    expect(y + h).toBeLessThanOrEqual(50.1);
    // Герой выше, чем шире: обрезка не оставила пустую ячейку квадратом.
    expect(h).toBeGreaterThan(w);
  });
});
