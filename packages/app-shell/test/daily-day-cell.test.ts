import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DayCell } from "../src/screens/meta/daily";

// Плитка дня награды (design/art/ui-ux.md, U-06): «СЕГОДНЯ» не помещалось в
// узкую плитку на 320 px. Сегодняшний день подписан так же, как остальные, —
// «День N», а «сегодня» передают рамка, цвет и точка.

const day = { day: 1, coins: 60, shards: 0, claimed: false, today: true };

describe("плитка дня награды", () => {
  it("сегодня — та же подпись «День N», без «Сегодня»", () => {
    const html = renderToStaticMarkup(createElement(DayCell, { day, index: 0, last: false }));
    expect(html).toContain("День 1");
    expect(html).not.toContain("Сегодня");
    expect(html).toContain('aria-current="date"');
  });

  it("сегодняшний день отмечен точкой, остальные — нет", () => {
    const today = renderToStaticMarkup(createElement(DayCell, { day, index: 2, last: false }));
    const other = renderToStaticMarkup(createElement(DayCell, { day: { ...day, today: false }, index: 2, last: false }));
    expect(today).toContain("data-today-dot");
    expect(other).not.toContain("data-today-dot");
  });

  it("подпись не переносится", () => {
    const html = renderToStaticMarkup(createElement(DayCell, { day, index: 6, last: true }));
    expect(html).toContain("whitespace-nowrap");
  });

  it("монеты лежат горстью своего размера, полученный день — галочкой", () => {
    const coins = (html: string): number => html.match(/data-pile-coin/g)?.length ?? 0;
    expect(coins(renderToStaticMarkup(createElement(DayCell, { day, index: 0, last: false, pile: 3 })))).toBe(3);
    expect(coins(renderToStaticMarkup(createElement(DayCell, { day, index: 0, last: false })))).toBe(1);
    expect(coins(renderToStaticMarkup(createElement(DayCell, { day: { ...day, claimed: true }, index: 0, last: false, pile: 3 })))).toBe(0);
  });
});
