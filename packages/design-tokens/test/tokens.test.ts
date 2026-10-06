import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLORS, CSS_VAR_BY_COLOR, DURATION, FONT_FAMILY, type ColorToken } from "../src/index";

/**
 * Синхронизация `tokens.css` и `index.ts` пакета токенов
 * (docs/27-design-system-and-app-shell.md §4.2, §9).
 *
 * Две копии палитры без проверки разойдутся на первой правке — так же, как
 * тип и валидация до Zod. Тест разбирает сам CSS, а не отдельный список: иначе
 * список стал бы третьей копией.
 */
const CSS = readFileSync(fileURLToPath(new URL("../src/tokens.css", import.meta.url)), "utf8");

function cssValue(name: string): string | null {
  const match = new RegExp(`${name}\s*:\s*([^;]+);`).exec(CSS);
  return match === null ? null : (match[1] ?? "").trim();
}

describe("базовые токены дизайна", () => {
  it("цвета совпадают по значению с CSS", () => {
    for (const token of Object.keys(COLORS) as ColorToken[]) {
      const variable = CSS_VAR_BY_COLOR[token];
      expect(cssValue(variable), `${token} → ${variable}`).toBe(COLORS[token]);
    }
  });

  it("описывает каждый цвет из CSS — новый токен не должен остаться без числа", () => {
    const declared = [...CSS.matchAll(/--color-[\w-]+/g)].map((match) => match[0]);
    const known = new Set(Object.values(CSS_VAR_BY_COLOR));
    for (const variable of new Set(declared)) {
      expect(known, `${variable} есть в CSS, но не в index.ts`).toContain(variable);
    }
  });

  it("совпадает по длительностям переходов", () => {
    expect(cssValue("--duration-fast")).toBe(`${DURATION.fast}ms`);
    expect(cssValue("--duration-base")).toBe(`${DURATION.base}ms`);
    expect(cssValue("--duration-slow")).toBe(`${DURATION.slow}ms`);
  });

  it("первые в стеках шрифтов — те же гарнитуры, что в FONT_FAMILY", () => {
    expect(cssValue("--font-display")).toMatch(new RegExp(`^"${FONT_FAMILY.display}"`));
    expect(cssValue("--font-text")).toMatch(new RegExp(`^"${FONT_FAMILY.text}"`));
  });

  it("не вход Tailwind: его импортирует вход приложения после tailwindcss", () => {
    const code = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/@import\s+"tailwindcss"/);
    expect(code).not.toMatch(/@source/);
  });
});
