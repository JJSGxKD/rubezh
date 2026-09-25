import { describe, expect, it } from "vitest";
import { hrefOf, parseRoute, resolveRoute, visibleSections, type Section } from "../src/routes";
import { formatDateTime, formatDelta, formatDuration, formatNumber } from "../src/format";

const SECTIONS: Section[] = [
  { id: "players", title: "Игроки", permission: "players.view" },
  { id: "roles", title: "Роли", permission: "roles.assign" },
];

describe("маршруты панели", () => {
  it("разбирает хэш и собирает его обратно", () => {
    expect(parseRoute("#/players/abc-1")).toEqual({ section: "players", id: "abc-1" });
    expect(parseRoute("#/players")).toEqual({ section: "players", id: null });
    expect(parseRoute("")).toBeNull();
    expect(hrefOf({ section: "players", id: "a b" })).toBe("#/players/a%20b");
    expect(parseRoute(hrefOf({ section: "players", id: "a b" }))).toEqual({ section: "players", id: "a b" });
  });

  it("показывает только разделы, на которые есть право", () => {
    expect(visibleSections(["players.view"], SECTIONS).map((section) => section.id)).toEqual(["players"]);
    expect(visibleSections([], SECTIONS)).toEqual([]);
  });

  it("закрытый раздел в адресе ведёт на первый открытый, а без разделов — никуда", () => {
    expect(resolveRoute({ section: "roles", id: null }, ["players.view"], SECTIONS)).toEqual({ section: "players", id: null });
    expect(resolveRoute({ section: "players", id: "x" }, ["players.view"], SECTIONS)).toEqual({ section: "players", id: "x" });
    expect(resolveRoute(null, ["roles.assign"], SECTIONS)).toEqual({ section: "roles", id: null });
    expect(resolveRoute(null, [], SECTIONS)).toBeNull();
  });
});

describe("отображение чисел и времени", () => {
  it("дата — местным временем, пусто и мусор — прочерк", () => {
    // Полдень по UTC — то же число в любом поясе от −11 до +11.
    expect(formatDateTime(Date.UTC(2026, 8, 25, 12, 0))).toContain("25.09.2026");
    expect(formatDateTime("2026-09-25T12:00:00.000Z")).toContain("25.09.2026");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("не дата")).toBe("—");
  });

  it("длительность забега, разряды и знак изменения", () => {
    expect(formatDuration(425)).toBe("7:05");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatNumber(1234567).replace(/\s/g, " ")).toBe("1 234 567");
    expect(formatDelta(50)).toBe("+50");
    expect(formatDelta(-20)).toBe("−20");
    expect(formatDelta(0)).toBe("0");
  });
});
