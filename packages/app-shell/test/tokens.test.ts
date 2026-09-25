import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FONT_FAMILY } from "../src/design-system/tokens";

/**
 * Токены оболочки игры (docs/27-design-system-and-app-shell.md §4.2). Палитра,
 * гарнитуры и длительности — в пакете `@bh/design-tokens`, и их синхронизацию
 * CSS ↔ TS проверяет его тест. Здесь — то, что добавляет игра: подключение
 * пакета, шрифты, отступы площадки.
 */
const CSS = readFileSync(fileURLToPath(new URL("../src/design-system/tokens.css", import.meta.url)), "utf8");

function cssValue(name: string): string | null {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(CSS);
  return match === null ? null : (match[1] ?? "").trim();
}

describe("токены оболочки", () => {
  it("подключает базовые токены пакетом сразу после Tailwind", () => {
    expect(CSS).toMatch(/@import "tailwindcss";\n@import "@bh\/design-tokens\/tokens\.css";/);
  });

  it("не заводит своих цветов мимо пакета — палитра одна на игру и панель", () => {
    expect([...CSS.matchAll(/^\s*(--color-[\w-]+)\s*:/gm)].map((match) => match[1])).toEqual([]);
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
