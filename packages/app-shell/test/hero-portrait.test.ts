import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPEARANCE_ORDER } from "../src/screens/meta/appearance-rules";
import { appearancePortraitUrl } from "../src/screens/meta/appearance-art";
import { heroPortrait } from "../src/screens/meta/hero-portrait";

describe("портрет героя в арсенале", () => {
  it("только зрителю с артом: без арта — прежняя фигура", () => {
    expect(heroPortrait(false, "vityaz")).toBeNull();
    expect(heroPortrait(false, undefined)).toBeNull();
  });

  it("с артом — портрет выбранного облика", () => {
    expect(heroPortrait(true, "vityaz")).toBe(appearancePortraitUrl("vityaz"));
    expect(heroPortrait(true, "navi")).toBe(appearancePortraitUrl("navi"));
  });

  it("облик ещё не пришёл или незнаком — Хранитель", () => {
    expect(heroPortrait(true, undefined)).toBe(appearancePortraitUrl("keeper"));
    expect(heroPortrait(true, "future")).toBe(appearancePortraitUrl("keeper"));
  });

  it("портреты собраны для всех обликов; герой выше, чем шире: обрезка не оставила пустую квадратную ячейку", () => {
    for (const id of APPEARANCE_ORDER) {
      const file = fileURLToPath(appearancePortraitUrl(id));
      expect(existsSync(file), `${id}: node design/art/src/portraits.mjs`).toBe(true);
      const viewBox = /viewBox="([^"]+)"/.exec(readFileSync(file, "utf8"))?.[1]?.split(" ").map(Number) ?? [];
      expect(viewBox, id).toHaveLength(4);
      const [, , w = 0, h = 0] = viewBox;
      expect(h, id).toBeGreaterThan(w);
    }
  });

  it("портрет Хранителя обрезан по кадру: рамка внутри ячейки атласа", () => {
    const viewBox = /viewBox="([^"]+)"/.exec(readFileSync(fileURLToPath(appearancePortraitUrl("keeper")), "utf8"))?.[1]?.split(" ").map(Number) ?? [];
    const [x = 0, y = 0, w = 0, h = 0] = viewBox;
    expect(x).toBeGreaterThanOrEqual(-50);
    expect(y).toBeGreaterThanOrEqual(-50);
    expect(x + w).toBeLessThanOrEqual(50.1);
    expect(y + h).toBeLessThanOrEqual(50.1);
  });
});
