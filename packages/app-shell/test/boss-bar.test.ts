import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BossBar } from "../src/screens/run/BossBar";

// Полоса босса v2 (design/art/direction-v2.md §4.4): деления фаз — там, где
// босс станет злее; украшения — только для глаза.

const bar = (phases: number): string =>
  renderToStaticMarkup(createElement(BossBar, { boss: { enemyId: "boss_matryoshka", hp: 600, maxHp: 1000, phase: 0, phases } }));

describe("полоса босса", () => {
  it("зарубка на каждой границе фаз", () => {
    const html = bar(3);
    expect(html).toContain("left:33.");
    expect(html).toContain("left:66.");
    expect(html.match(/border-r border-bg\/70/g)).toHaveLength(2);
  });

  it("одна фаза — без зарубок", () => {
    expect(bar(1)).not.toContain("border-r border-bg/70");
  });

  it("украшения скрыты от скринридера, имя и фаза — текстом", () => {
    const html = bar(3);
    expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain("Матрёшка");
    expect(html).toMatch(/1\D+3/);
  });
});
