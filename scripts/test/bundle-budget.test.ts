import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { budgetRows, budgetFailed } from "../bundle-budget.mjs";

// Расчёт строк бюджета бандла (tasks/T-0142): «fail» проваливает гейт,
// «watch» — только пометка «следим». Размеры уже в байтах gzip.

interface Row {
  name: string;
  kb: number;
  limitKb: number;
  kind: "fail" | "watch";
  over: boolean;
  files: string[];
  largest?: string;
}

const KB = 1024;
const chunks = [
  { name: "shop-a.js", bytes: 12 * KB },
  { name: "tasks-b.js", bytes: 8 * KB },
  { name: "guide-c.js", bytes: 6 * KB },
  { name: "other-d.js", bytes: 1 * KB },
];
const screen = (name: string) => /^(shop|tasks|guide)-/.test(name);

function rowsFor(limits: { biggest: number; total: number }): Row[] {
  return budgetRows(chunks, [
    { name: "Самый большой экран", limitKb: limits.biggest, kind: "fail", measure: "max", matches: screen },
    { name: "Экраны по требованию, всего", limitKb: limits.total, kind: "watch", matches: screen },
  ]);
}

describe("строки бюджета", () => {
  it("сумма группы — по чанкам, самый большой — максимум", () => {
    const [biggest, total] = rowsFor({ biggest: 15, total: 145 });
    expect(biggest).toMatchObject({ kb: 12, largest: "shop-a.js", kind: "fail", over: false });
    expect(total).toMatchObject({ kb: 26, kind: "watch", over: false, files: ["shop-a.js", "tasks-b.js", "guide-c.js"] });
  });

  it("чужие чанки в группу не попадают", () => {
    const [, total] = rowsFor({ biggest: 15, total: 145 });
    expect(total?.files).not.toContain("other-d.js");
  });

  it("самый большой экран вышел за порог — гейт проваливается", () => {
    const rows = rowsFor({ biggest: 11.5, total: 145 });
    expect(rows[0]).toMatchObject({ over: true, kind: "fail", largest: "shop-a.js" });
    expect(budgetFailed(rows)).toBe(true);
  });

  it("сумма вышла за порог — только пометка, гейт не проваливается", () => {
    const rows = rowsFor({ biggest: 15, total: 20 });
    expect(rows[1]).toMatchObject({ over: true, kind: "watch" });
    expect(budgetFailed(rows)).toBe(false);
  });

  it("ровно на пороге — не превышение", () => {
    const rows = rowsFor({ biggest: 12, total: 26 });
    expect(rows.map((row) => row.over)).toEqual([false, false]);
  });

  it("группа без файлов — провал: сборка не та или её не делали", () => {
    const rows = budgetRows([], [{ name: "Самый большой экран", limitKb: 15, kind: "fail", measure: "max", matches: screen }]);
    expect(rows[0]).toMatchObject({ kb: 0, files: [] });
    expect(budgetFailed(rows)).toBe(true);
  });

  it("по умолчанию группа — fail и сумма", () => {
    const [row] = budgetRows(chunks, [{ name: "Экраны", limitKb: 25, matches: screen }]);
    expect(row).toMatchObject({ kind: "fail", kb: 26, over: true });
  });
});
