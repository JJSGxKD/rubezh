import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListGroup, ListItem } from "../src/design-system/components";

// Фокус с клавиатуры (docs/27 §4.4): своё кольцо светлого акцента вместо
// обводки браузера — та у каждого движка своя. Правило — в слое base:
// глобальное правило вне слоя перебило бы утилиты Tailwind, и строка списка не
// смогла бы увести кольцо внутрь.

const CSS = readFileSync(new URL("../src/design-system/tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("кольцо фокуса", () => {
  it("одно на всё приложение, в слое base, только для :focus-visible", () => {
    const layer = /@layer base \{[\s\S]*?\n\}/.exec(CSS)?.[0] ?? "";
    expect(layer).toMatch(/:focus-visible \{[^}]*outline: 2px solid var\(--color-accent-glow\)/);
    expect(layer).toMatch(/outline-offset: 2px/);
    expect(CSS.replace(/@layer base \{[\s\S]*?\n\}/, "")).not.toMatch(/:focus-visible/);
  });

  it("строка списка — кольцом внутрь: группа обрезает всё, что снаружи", () => {
    const html = renderToStaticMarkup(createElement(ListGroup, { children: createElement(ListItem, { title: "Об игре", onClick: () => undefined }) }));
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("focus-visible:-outline-offset-2");
  });

  it("строка без действия кольца не просит — её не выбрать клавишей", () => {
    const html = renderToStaticMarkup(createElement(ListItem, { title: "Версия", value: "1.0" }));
    expect(html).not.toContain("outline-offset");
  });

  it("вкладки нижней панели — тоже внутрь: крайние стоят у края экрана", () => {
    const layout = readFileSync(new URL("../src/design-system/components/Layout.tsx", import.meta.url), "utf8");
    expect(layout).toMatch(/min-h-16[^"]*focus-visible:-outline-offset-2/);
  });
});
