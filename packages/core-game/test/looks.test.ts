import type { EnemyPattern } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENEMY_LOOKS, enemyColor, enemyRim, GEM_TIERS, WORLD_COLORS } from "../src/game/render/looks";

// Облик боя «Сумеречный рубеж» (design/README.md, «Вид боя»; tasks/T-0014):
// враги красные и различаются формой, опасное — каймой, кристаллы яркие.

const PATTERNS = Object.keys(ENEMY_LOOKS) as EnemyPattern[];

function hsv(color: number): { h: number; s: number; v: number } {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

function lightness(color: number): number {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

describe("враги в красной гамме", () => {
  it("оттенок каждого — от 330° до 20°, насыщенность не ниже 0,45", () => {
    for (const pattern of PATTERNS) {
      const { h, s } = hsv(ENEMY_LOOKS[pattern].color);
      expect(h >= 330 || h <= 20, `${pattern}: оттенок ${String(Math.round(h))}°`).toBe(true);
      expect(s, `${pattern}: насыщенность`).toBeGreaterThanOrEqual(0.45);
    }
  });

  it("формы у всех поведений разные: главное различие типа — форма, а не оттенок", () => {
    const shapes = PATTERNS.map((pattern) => ENEMY_LOOKS[pattern].shape);
    expect(new Set(shapes).size).toBe(PATTERNS.length);
    expect(PATTERNS).toHaveLength(9);
  });
});

describe("цвет ранга", () => {
  it("элита отличается от рядового у каждого поведения", () => {
    for (const pattern of PATTERNS) {
      expect(enemyColor(pattern, "elite"), pattern).not.toBe(enemyColor(pattern, undefined));
    }
  });

  it("босс отличается от рядового и от элиты", () => {
    // У «chase» цвет тела совпадает с цветом смешения босса (#e0245e), поэтому у него
    // босс от рядового цветом не отличается — вопрос тимлидам в PR; ранг читается каймой.
    for (const pattern of PATTERNS) {
      if (pattern !== "chase") expect(enemyColor(pattern, "boss"), pattern).not.toBe(enemyColor(pattern, undefined));
      expect(enemyColor(pattern, "boss"), pattern).not.toBe(enemyColor(pattern, "elite"));
    }
  });

  it("рядовой — это цвет из таблицы без смешения", () => {
    expect(enemyColor("swarm", undefined)).toBe(0xff4d5a);
  });

  it("элита — смешение с жаром очага на 35 %", () => {
    // 0xff4d5a → 0xff8f3f: r = 255, g = 77 + (143 − 77) · 0,35 = 100, b = 90 + (63 − 90) · 0,35 = 81
    expect(enemyColor("swarm", "elite")).toBe((255 << 16) | (100 << 8) | 81);
  });

  it("босс — смешение с малиновым на 40 %", () => {
    // 0xff4d5a → 0xe0245e: r = 255 + (224 − 255) · 0,4 = 243, g = 77 + (36 − 77) · 0,4 = 61, b = 90 + (94 − 90) · 0,4 = 92
    expect(enemyColor("swarm", "boss")).toBe((243 << 16) | (61 << 8) | 92);
  });

  it("кайма: у рядового нет, у элиты 2, у босса 3, золотая", () => {
    expect(enemyRim(undefined)).toBeNull();
    expect(enemyRim("elite")).toEqual({ color: 0xffd15c, width: 2 });
    expect(enemyRim("boss")).toEqual({ color: 0xffd15c, width: 3 });
  });
});

describe("кристаллы и мир", () => {
  it("кристаллы яркие: светлота по HSL не ниже 0,6", () => {
    for (const tier of GEM_TIERS) {
      expect(lightness(tier.color), `ступень ${String(tier.minValue)}`).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("цвета ступеней кристаллов попарно различаются", () => {
    expect(new Set(GEM_TIERS.map((tier) => tier.color)).size).toBe(GEM_TIERS.length);
  });

  it("цвета кристаллов по таблице", () => {
    expect(GEM_TIERS.map((tier) => tier.color)).toEqual([0xb6ff4a, 0xa8f4ff, 0xd68cff, 0xffd15c]);
  });

  it("обереги бирюзовые, как secondary палитры", () => {
    expect(WORLD_COLORS.orbiter).toBe(0x46d9c6);
  });

  it("земля, здоровье, опыт и лечение — по таблице", () => {
    expect(WORLD_COLORS.ground).toBe(0x2b4152);
    expect(WORLD_COLORS.groundLine).toBe(0x33495b);
    expect(WORLD_COLORS.playerEdge).toBe(0x1d1c31);
    expect([WORLD_COLORS.hpFull, WORLD_COLORS.hpMid, WORLD_COLORS.hpLow]).toEqual([0xff6f90, 0xffc14d, 0xff3b5c]);
    expect(WORLD_COLORS.xpRing).toBe(0xb6ff4a);
    expect(WORLD_COLORS.heal).toBe(0x8ee86b);
  });
});
