import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TabBar } from "../src/design-system/components";

// Бейдж нижней панели (design/art/ui-ux.md, U-15): на поднятой оранжевой
// плитке красный бейдж сливался с её краем. Кольцо цвета панели отделяет его
// от плитки, у активной вкладки бейдж вынесен дальше за угол.

const items = [
  { id: "home", label: "Главная", icon: createElement("i"), badge: "1" },
  { id: "tasks", label: "Задания", icon: createElement("i"), badge: "2" },
];

function badgeClass(html: string, text: string): string[] {
  const match = new RegExp(`<span class="([^"]*)">${text}</span>`).exec(html);
  return match?.[1]?.split(" ") ?? [];
}

describe("бейдж нижней панели", () => {
  const html = renderToStaticMarkup(createElement(TabBar, { track: "test", items, activeId: "home", onSelect: () => undefined }));

  it("отделён от плитки кольцом цвета панели", () => {
    expect(badgeClass(html, "1")).toEqual(expect.arrayContaining(["ring-2", "ring-surface"]));
    expect(badgeClass(html, "2")).toEqual(expect.arrayContaining(["ring-2", "ring-surface"]));
  });

  it("у активной вкладки вынесен за угол дальше, чем у обычной", () => {
    expect(badgeClass(html, "1")).toContain("-top-2");
    expect(badgeClass(html, "2")).toContain("-top-1");
  });
});
