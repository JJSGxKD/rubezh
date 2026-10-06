import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECTION_GROUPS, SECTIONS as MENU, hrefOf, locateSection, parseRoute, resolveRoute, visibleGroups, visibleSections, type Section, type SectionGroup } from "../src/routes";
import { formatDateTime, formatDelta, formatDuration, formatNumber } from "../src/format";

const SECTIONS: Section[] = [
  { id: "players", title: "Игроки", hint: "карточка игрока", permission: "players.view" },
  { id: "roles", title: "Роли", hint: "кто что может", permission: "roles.assign" },
];

const GROUPS: SectionGroup[] = [
  { title: "Поддержка", sections: [SECTIONS[0] as Section] },
  { title: "Команда", sections: [SECTIONS[1] as Section, { id: "audit", title: "Аудит", hint: "кто что менял", permission: "audit.view" }] },
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

describe("меню панели", () => {
  it("группа без открытых разделов не показывается, в остальных — только открытые", () => {
    expect(visibleGroups(["players.view", "audit.view"], GROUPS)).toEqual([
      { title: "Поддержка", sections: [SECTIONS[0]] },
      { title: "Команда", sections: [{ id: "audit", title: "Аудит", hint: "кто что менял", permission: "audit.view" }] },
    ]);
    expect(visibleGroups(["players.view"], GROUPS).map((group) => group.title)).toEqual(["Поддержка"]);
    expect(visibleGroups([], GROUPS)).toEqual([]);
  });

  it("находит раздел и его группу для шапки, чужой — нет", () => {
    expect(locateSection("audit", GROUPS)?.group.title).toBe("Команда");
    expect(locateSection("roles", GROUPS)?.section.title).toBe("Роли");
    expect(locateSection("nope", GROUPS)).toBeNull();
  });

  it("разделы не повторяются, у каждого есть подсказка, группы не пустые", () => {
    const ids = MENU.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of SECTION_GROUPS) expect(group.sections.length, group.title).toBeGreaterThan(0);
    for (const section of MENU) {
      expect(section.hint.trim(), section.id).not.toBe("");
      // подсказка — строка в шапке рядом с названием, а не абзац
      expect(section.hint.length, section.id).toBeLessThanOrEqual(80);
    }
  });

  it("у каждого раздела меню есть экран, и каждый экран стоит в меню", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/screens/sections.tsx", import.meta.url)), "utf8");
    const screens = [...source.matchAll(/^\s+"?([a-z-]+)"?: \(/gm)].map((match) => match[1]);
    expect([...screens].sort()).toEqual(MENU.map((section) => section.id).sort());
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
