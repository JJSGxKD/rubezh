import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SectionTitle } from "../src/design-system/components";

// Заголовок раздела с каймой-оберегом (design/art/direction-v2.md §4.4):
// украшения — только для глаза, скринридер читает одну подпись.

describe("заголовок раздела", () => {
  const html = renderToStaticMarkup(createElement(SectionTitle, null, "Снаряжение"));

  it("ромб и кайма скрыты от скринридера", () => {
    const hidden = html.match(/aria-hidden="true"/g) ?? [];
    expect(hidden).toHaveLength(2);
    expect(html).toContain("section-rule");
  });

  it("подпись — текст заголовка второго уровня, длинная может сжиматься", () => {
    expect(html.startsWith("<h2")).toBe(true);
    expect(html).toContain('<span class="min-w-0">Снаряжение</span>');
  });
});
