import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Screen, SegmentedControl } from "../src/design-system/components/Layout";

// Страница не ездит вбок (tasks/T-0442, Р210): прокрутка вбок — только у своих
// строк, у элемента сетки с такой строкой — min-w-0.

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${String(i)}`, label: `Пункт ${String(i)}` }));
const control = (n: number): string =>
  renderToStaticMarkup(createElement(SegmentedControl, { items: items(n), activeId: "i0", label: "Вкладки", onSelect: () => undefined, track: "test" }));

describe("страница не прокручивается вбок", () => {
  it("вкладки (4 пункта): корень min-w-0, лента прокручивается сама", () => {
    const html = control(4);
    expect(html).toMatch(/^<div class="[^"]*\bmin-w-0\b/);
    expect(html).toMatch(/role="tablist"[^>]*class="[^"]*\boverflow-x-auto\b/);
  });

  it("лунка (3 пункта): корень min-w-0", () => {
    expect(control(3)).toMatch(/^<div[^>]*class="[^"]*\bmin-w-0\b/);
  });

  it("Screen: прокрутчик вниз, но не вбок", () => {
    const html = renderToStaticMarkup(createElement(Screen, {}, "x"));
    const classes = /class="([^"]*\boverflow-y-auto\b[^"]*)"/.exec(html)?.[1] ?? "";
    expect(classes).toMatch(/\boverflow-x-hidden\b/);
  });

  it("surface-glass: фон шапки — 85 % цвета фона", () => {
    const css = readFileSync(new URL("../src/design-system/tokens.css", import.meta.url), "utf8");
    const block = /@utility surface-glass \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/background: color-mix\(in oklab, var\(--color-bg\) 85%, transparent\)/);
  });
});
