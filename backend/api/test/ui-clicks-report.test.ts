import { describe, expect, it } from "vitest";
import { buildUiClickRows, sharePercent } from "../src/modules/funnel/ui-clicks-report.js";

// Чистая часть отчёта «Нажатия» (tasks/T-0228): доли и порядок строк.
// Запросы к базе — ui-clicks-report.integration.test.ts.

describe("доля нажавших от открывших экран", () => {
  it("1 120 из 4 210 — 26,6%", () => {
    expect(sharePercent(1120, 4210)).toBe(26.6);
  });

  it("2 050 из 4 210 — 48,7%", () => {
    expect(sharePercent(2050, 4210)).toBe(48.7);
  });

  it("экран без открытий — null, а не деление на ноль", () => {
    expect(sharePercent(5, 0)).toBeNull();
    expect(sharePercent(0, 0)).toBeNull();
  });

  it("не больше 100%: нажали без события открытия — доля упирается в потолок", () => {
    expect(sharePercent(12, 10)).toBe(100);
  });

  it("ноль нажавших — 0", () => {
    expect(sharePercent(0, 40)).toBe(0);
  });
});

describe("строки отчёта", () => {
  it("кнопки — по убыванию нажатий, при равенстве — по имени", () => {
    const rows = buildUiClickRows(
      [
        { control: "buy", clicks: 1930, players: 1120 },
        { control: "tabs.gems", clicks: 3400, players: 2050 },
        { control: "back", clicks: 1930, players: 900 },
      ],
      4210,
    );
    expect(rows.map((row) => row.control)).toEqual(["tabs.gems", "back", "buy"]);
    expect(rows[0]).toEqual({ control: "tabs.gems", clicks: 3400, players: 2050, share: 48.7 });
    expect(rows[2]?.share).toBe(26.6);
  });

  it("без открытий доля у всех строк — null", () => {
    const rows = buildUiClickRows([{ control: "buy", clicks: 3, players: 2 }], 0);
    expect(rows[0]?.share).toBeNull();
  });

  it("нет нажатий — нет строк", () => {
    expect(buildUiClickRows([], 100)).toEqual([]);
  });
});
