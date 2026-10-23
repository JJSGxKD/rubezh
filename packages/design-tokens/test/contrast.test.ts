import { describe, expect, it } from "vitest";
import { COLORS, type ColorToken } from "../src/index";

/**
 * Контраст текста по WCAG 2.2 (docs/27-design-system-and-app-shell.md §4.2):
 * обычный текст — не ниже 4,5:1, на всех ступенях поверхности. Замер готовых
 * экранов — `design/art/src/contrast-audit.mjs`; здесь — то, что держит сама
 * палитра, чтобы правка цвета не опустила текст ниже порога незаметно.
 */

const NORMAL = 4.5;

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: readonly number[]): number {
  const lin = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Тон поверх поверхности долей `share` — так ложится `bg-accent/15`. */
function tint(tone: ColorToken, ground: ColorToken, share: number): number[] {
  const [a, b] = [channels(COLORS[tone]), channels(COLORS[ground])];
  return a.map((value, index) => value * share + (b[index] ?? 0) * (1 - share));
}

const GROUNDS = ["bg", "surface", "surfaceRaised", "surfaceSunken"] as const;

describe("контраст палитры", () => {
  it("основной и приглушённый текст читаются на любой поверхности", () => {
    for (const text of ["text", "textMuted"] as const) {
      for (const ground of GROUNDS) {
        expect(contrast(channels(COLORS[text]), channels(COLORS[ground])), `${text} на ${ground}`).toBeGreaterThanOrEqual(NORMAL);
      }
    }
  });

  it("text-disabled — только для выключенного: читать им нельзя", () => {
    // Порог WCAG выключенные элементы не касается; если серый дорос до 4,5,
    // выключенное перестанет отличаться от подписи.
    expect(contrast(channels(COLORS.textDisabled), channels(COLORS.surface))).toBeLessThan(NORMAL);
  });

  it("цвет тона на своей плашке держит 4,5, на какой бы карточке плашка ни лежала", () => {
    // Плашка — тон поверх лунки непрозрачно (`.badge-tinted` оболочки):
    // полупрозрачная светлела на поднятой и выбранной карточке.
    for (const tone of ["accent", "danger", "warning", "info", "weapon", "passive"] as const) {
      expect(contrast(channels(COLORS[tone]), tint(tone, "surfaceSunken", 0.15)), tone).toBeGreaterThanOrEqual(NORMAL);
    }
  });

  it("полупрозрачная плашка на поднятой карточке тон не держит — потому подложка и непрозрачная", () => {
    for (const tone of ["accent", "danger", "passive"] as const) {
      expect(contrast(channels(COLORS[tone]), tint(tone, "surfaceRaised", 0.15)), tone).toBeLessThan(NORMAL);
    }
  });

  it("подпись «сегодня» на выбранной карточке — бликом акцента, а не самим акцентом", () => {
    const selected = tint("accent", "surfaceRaised", 0.14);
    expect(contrast(channels(COLORS.accentGlow), selected)).toBeGreaterThanOrEqual(NORMAL);
    expect(contrast(channels(COLORS.accent), selected)).toBeLessThan(NORMAL);
  });

  it("текст на заливке кнопок", () => {
    expect(contrast(channels(COLORS.onAccent), channels(COLORS.accentPressed))).toBeGreaterThanOrEqual(NORMAL);
    expect(contrast(channels(COLORS.onSecondary), channels(COLORS.secondary))).toBeGreaterThanOrEqual(NORMAL);
    expect(contrast(channels(COLORS.onStars), channels(COLORS.stars))).toBeGreaterThanOrEqual(NORMAL);
  });
});
