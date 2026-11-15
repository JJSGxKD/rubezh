import { describe, expect, it } from "vitest";
import { GROUND_CELL_UNITS, groundCellRect, groundTint, hash01, valueNoise, zoneAt } from "../src/game/render/art-ground";

// Земля чернового арта (design/art/environment.md): рендер, на исход забега
// не влияет, но шов между клетками и пропавшая зона видны сразу.

describe("раскладка земли", () => {
  it("хэш — в [0, 1) и повторяется на тех же координатах", () => {
    for (let x = -50; x < 50; x += 7) for (let y = -50; y < 50; y += 11) {
      const h = hash01(x, y, 3);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      expect(hash01(x, y, 3)).toBe(h);
    }
  });

  it("шум непрерывен: соседние точки не прыгают", () => {
    for (let x = 0; x < 4000; x += 97) {
      expect(Math.abs(valueNoise(x, 100, 1920, 11) - valueNoise(x + 1, 100, 1920, 11))).toBeLessThan(0.01);
    }
  });

  it("на большой карте встречаются все три зоны", () => {
    const zones = new Set<string>();
    for (let x = -40; x < 40; x++) for (let y = -20; y < 20; y++) zones.add(zoneAt(x * 384, y * 384));
    expect([...zones].sort()).toEqual(["graveyard", "meadow", "mire"]);
  });

  it("тинт считается по точке, а не по клетке: общий угол соседей одного цвета — без шва", () => {
    const corner = groundTint(3 * 256, 5 * 256);
    expect(groundTint(3 * 256, 5 * 256)).toBe(corner);
    expect(corner).toBeGreaterThan(0);
    expect(corner).toBeLessThanOrEqual(0xffffff);
  });
});

describe("клетки земли без щели", () => {
  it("клетки стыкуются без щели: правый край не левее левого края соседа", () => {
    for (const s of [1, 1.7]) {
      for (let gx = -3; gx <= 3; gx++) {
        const a = groundCellRect(gx, 0, s);
        const b = groundCellRect(gx + 1, 0, s);
        expect(a.x + a.width).toBeGreaterThanOrEqual(b.x);
      }
    }
  });

  it("то же по вертикали: низ клетки не выше верха соседа", () => {
    for (const s of [1, 1.7]) {
      for (let gy = -3; gy <= 3; gy++) {
        const a = groundCellRect(0, gy, s);
        const b = groundCellRect(0, gy + 1, s);
        expect(a.y + a.width).toBeGreaterThanOrEqual(b.y);
      }
    }
  });

  it("перекрытие меньше пикселя мира на единицу: ширина больше стороны не более чем на unitScale", () => {
    for (const s of [1, 1.7]) {
      const rect = groundCellRect(2, 1, s);
      const size = GROUND_CELL_UNITS * s;
      expect(rect.width).toBeGreaterThan(size);
      expect(rect.width - size).toBeLessThanOrEqual(s + 1e-9);
    }
  });

  it("позиция клетки прежняя: gx * сторона", () => {
    const rect = groundCellRect(-2, 3, 1.7);
    expect(rect.x).toBeCloseTo(-2 * GROUND_CELL_UNITS * 1.7, 9);
    expect(rect.y).toBeCloseTo(3 * GROUND_CELL_UNITS * 1.7, 9);
  });
});
