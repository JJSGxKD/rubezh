import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет и не нужно
import { CATEGORIES, countCategories, formatTable, isLeadComment, parseFindings } from "../lead/review-stats.mjs";

// Категории замечаний ревью (T-0475, Р224, C): код в квадратных скобках в
// начале пункта, скрипт считает их по PR и показывает повторяющиеся.

const codesOf = (body: string): string[] => parseFindings(body).map((f: { code: string }) => f.code);

describe("isLeadComment: подпись тимлида", () => {
  it("claude-lead-N и claude-lead2-N — свои", () => {
    expect(isLeadComment("**claude-lead-1:** замечания")).toBe(true);
    expect(isLeadComment("**claude-lead2-3:** замечания")).toBe(true);
  });
  it("исполнитель и ревьюер — мимо", () => {
    expect(isLeadComment("**claude-3:** доработано")).toBe(false);
    expect(isLeadComment("**claude-review-2:** замечания")).toBe(false);
    expect(isLeadComment("без подписи")).toBe(false);
  });
  it("подпись не в начале — мимо", () => {
    expect(isLeadComment("текст\n**claude-lead-1:** позже")).toBe(false);
  });
});

describe("parseFindings: пункты замечаний", () => {
  it("код в начале пункта, несколько пунктов", () => {
    expect(codesOf("**claude-lead-1:** Request changes\n- [zones] путь вне зон\n- [tests] тест подогнан")).toEqual(["zones", "tests"]);
  });
  it("нумерованный список и звёздочка", () => {
    expect(codesOf("**claude-lead-1:**\n1. [docs] документ\n* [security] секрет")).toEqual(["docs", "security"]);
  });
  it("пункт без кода — other", () => {
    expect(codesOf("**claude-lead-1:**\n- что-то не так")).toEqual(["other"]);
  });
  it("неизвестный код — other", () => {
    expect(codesOf("**claude-lead-1:**\n- [wat] ?")).toEqual(["other"]);
  });
  it("отметки чек-листа не замечания", () => {
    expect(codesOf("**claude-lead-1:**\n- [x] готово\n- [ ] не готово\n- [X] ещё")).toEqual([]);
  });
  it("обычный текст не пункт", () => {
    expect(codesOf("**claude-lead-1:** всё хорошо, принято")).toEqual([]);
  });
  it("код в верхнем регистре приводится к нижнему", () => {
    expect(codesOf("**claude-lead-1:**\n- [Zones] x")).toEqual(["zones"]);
  });
  it("закрытый список полон", () => {
    expect([...CATEGORIES].sort()).toEqual(
      ["docs", "gate", "layers", "migration", "money", "other", "perf", "pr-format", "screens", "security", "spec", "tests", "texts", "zones"].sort(),
    );
  });
});

describe("countCategories: подсчёт и сортировка", () => {
  const comments = [
    { pr: 745, body: "**claude-lead-1:**\n- [zones] a\n- [tests] b" },
    { pr: 748, body: "**claude-lead-1:**\n- [zones] a" },
    { pr: 755, body: "**claude-lead-1:**\n- [zones] a\n- [zones] ещё" },
    { pr: 756, body: "**claude-3:**\n- [zones] чужая подпись" },
    { pr: 757, body: "**claude-lead-1:**\n- [zones] a" },
  ];
  it("чужая подпись мимо, сортировка по убыванию", () => {
    const rows = countCategories(comments);
    expect(rows[0]).toMatchObject({ code: "zones", count: 5 });
    expect(rows[1]).toMatchObject({ code: "tests", count: 1 });
    expect(rows).toHaveLength(2);
  });
  it("последние три PR без повторов, свежие первыми", () => {
    expect(countCategories(comments)[0].prs).toEqual([757, 755, 748]);
  });
  it("при равенстве — по алфавиту кода", () => {
    const rows = countCategories([{ pr: 1, body: "**claude-lead-1:**\n- [tests] a\n- [docs] b" }]);
    expect(rows.map((r: { code: string }) => r.code)).toEqual(["docs", "tests"]);
  });
  it("пусто — пустой список", () => {
    expect(countCategories([])).toEqual([]);
  });
});

describe("formatTable", () => {
  it("строка «категория — сколько — PR»", () => {
    expect(formatTable([{ code: "zones", count: 7, prs: [755, 748, 745] }])).toContain("zones — 7 — #755, #748, #745");
  });
  it("пусто — сообщение", () => {
    expect(formatTable([])).toContain("нет");
  });
});
