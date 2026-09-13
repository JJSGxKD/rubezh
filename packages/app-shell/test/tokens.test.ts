import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COLORS,
  CSS_VAR_BY_COLOR,
  DURATION,
  FONT_FAMILY,
  type ColorToken,
} from "../src/design-system/tokens";

/**
 * Синхронизация `tokens.css` и `tokens.ts`
 * (docs/27-design-system-and-app-shell.md §4.2, §9).
 *
 * Две копии палитры без проверки разойдутся на первой правке — так же, как
 * тип и валидация до Zod. Тест разбирает сам CSS, а не отдельный список: иначе
 * список стал бы третьей копией.
 */
const CSS = readFileSync(
  fileURLToPath(new URL("../src/design-system/tokens.css", import.meta.url)),
  "utf8",
);

function cssValue(name: string): string | null {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(CSS);
  return match === null ? null : match[1].trim();
}

describe("токены дизайн-системы", () => {
  it("совпадают по значению с CSS", () => {
    for (const token of Object.keys(COLORS) as ColorToken[]) {
      const variable = CSS_VAR_BY_COLOR[token];
      expect(cssValue(variable), `${token} → ${variable}`).toBe(COLORS[token]);
    }
  });

  it("описывает каждый цвет из CSS — новый токен не должен остаться без числа", () => {
    const declared = [...CSS.matchAll(/--color-[\w-]+/g)].map((match) => match[0]);
    const known = new Set(Object.values(CSS_VAR_BY_COLOR));

    for (const variable of new Set(declared)) {
      expect(known, `${variable} есть в CSS, но не в tokens.ts`).toContain(variable);
    }
  });

  it("совпадает по длительностям переходов", () => {
    expect(cssValue("--duration-fast")).toBe(`${DURATION.fast}ms`);
    expect(cssValue("--duration-base")).toBe(`${DURATION.base}ms`);
    expect(cssValue("--duration-slow")).toBe(`${DURATION.slow}ms`);
  });

  it("ждёт при запуске те же гарнитуры, что стоят первыми в стеках шрифтов", () => {
    // Разойдись имена — экран загрузки ждал бы шрифт, которого нет, и всегда
    // уходил бы по таймауту.
    expect(cssValue("--font-display")).toMatch(new RegExp(`^"${FONT_FAMILY.display}"`));
    expect(cssValue("--font-text")).toMatch(new RegExp(`^"${FONT_FAMILY.text}"`));
  });

  it("подключает в fonts.css гарнитуры с теми же именами", () => {
    const fonts = readFileSync(
      fileURLToPath(new URL("../src/design-system/fonts.css", import.meta.url)),
      "utf8",
    );
    const families = new Set(
      [...fonts.matchAll(/font-family:\s*"([^"]+)"/g)].map((match) => match[1]),
    );
    expect([...families].sort()).toEqual([FONT_FAMILY.display, FONT_FAMILY.text].sort());
  });

  it("объявляет отступы безопасной зоны и высоту вьюпорта", () => {
    // Оболочка выставляет их из данных адаптера; без объявления вёрстка
    // получила бы пустую переменную и схлопнула отступ в ноль (§5.1).
    for (const name of [
      "--app-inset-top",
      "--app-inset-right",
      "--app-inset-bottom",
      "--app-inset-left",
      "--app-viewport-height",
    ]) {
      expect(cssValue(name), name).not.toBeNull();
    }
  });
});
