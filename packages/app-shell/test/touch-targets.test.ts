import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Toggle } from "../src/design-system/components";
import { SlideDots } from "../src/screens/home-slide";

// Зона касания (docs/27 §4.4): облик бывает ниже 44 px — переключатель 32,
// фильтр 32, точка карусели 24, — а палец промахивается по нему. `hit-tall`
// добирает зону до 44 px по высоте прозрачным `::after`, не трогая раскладку.
// По ширине не добирает: соседние точки карусели перекрыли бы друг друга.

const CSS = readFileSync(new URL("../src/design-system/tokens.css", import.meta.url), "utf8");

describe("зона касания маленьких элементов", () => {
  it("утилита добирает высоту до 44 px и не сужает высокие", () => {
    const rule = /@utility hit-tall \{[\s\S]*?\n\}/.exec(CSS)?.[0] ?? "";
    expect(rule).toContain("position: relative");
    expect(rule).toMatch(/top: min\(0px, calc\(\(100% - 2\.75rem\) \/ 2\)\)/);
    expect(rule).toMatch(/bottom: min\(0px, calc\(\(100% - 2\.75rem\) \/ 2\)\)/);
    expect(rule).toMatch(/left: 0/);
  });

  it("переключатель", () => {
    expect(renderToStaticMarkup(createElement(Toggle, { checked: false, onChange: () => undefined, label: "Вибрация" }))).toContain("hit-tall");
  });

  it("точки карусели", () => {
    const html = renderToStaticMarkup(createElement(SlideDots, { ids: ["a", "b"], current: 0, onSelect: () => undefined }));
    expect(html.match(/hit-tall/g)?.length).toBe(2);
  });

  it("фильтры истории и точки баннеров магазина", () => {
    const history = readFileSync(new URL("../src/screens/meta/history.tsx", import.meta.url), "utf8");
    expect(history).toMatch(/role="tab"[\s\S]{0,200}hit-tall/);
    const banners = readFileSync(new URL("../src/screens/meta/shop-banners.tsx", import.meta.url), "utf8");
    expect(banners).toMatch(/shop\.banner\.position[\s\S]{0,200}hit-tall/);
  });
});
