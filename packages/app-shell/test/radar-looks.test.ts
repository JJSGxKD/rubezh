import { describe, expect, it } from "vitest";
import { COLORS } from "../src/design-system/tokens";
import { RADAR_COLORS } from "../src/screens/run/radar-looks";

// Цвета точек радара (tasks/T-0097): аптечка зелёная, как подбор на земле, —
// красная сливалась с врагами. Раскладку («радар вверху справа») тестом не
// закрыть, её проверяет глазами тот, кто принимает.

function channels(hex: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

describe("цвета точек радара", () => {
  it("аптечка — токен успеха, тот же зелёный, что на земле", () => {
    expect(RADAR_COLORS.medkit).toBe(COLORS.success);
  });

  it("цвет аптечки зелёный: канал g больше r и b", () => {
    const { r, g, b } = channels(RADAR_COLORS.medkit);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it("аптечка не совпадает ни с врагом, ни с элитой", () => {
    expect(RADAR_COLORS.medkit).not.toBe(RADAR_COLORS.enemy);
    expect(RADAR_COLORS.medkit).not.toBe(RADAR_COLORS.elite);
  });

  it("все шесть цветов попарно различны", () => {
    expect(new Set(Object.values(RADAR_COLORS)).size).toBe(6);
  });
});
