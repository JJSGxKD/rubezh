import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { globToRegExp, holdingPattern, matches, outOfZone, outOfZoneHint, tasksHolding, zonesOverlap } from "../tasks/zones.mjs";

// Зоны задач: шаблоны путей, пересечения и выход за зоны.

const SHOP = "backend/api/src/modules/shop";
const WALLET = "backend/api/src/modules/wallet";

describe("шаблоны путей", () => {
  it("a/** — любые вложенные каталоги, в том числе нулевой вложенности", () => {
    expect(globToRegExp("a/**").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("a/**").test("a/c.ts")).toBe(true);
    expect(globToRegExp("a/**").test("b/c.ts")).toBe(false);
  });

  it("* не переходит через «/»", () => {
    expect(globToRegExp("a/*.ts").test("a/c.ts")).toBe(true);
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false);
  });

  it("**/ совпадает и с нулём каталогов", () => {
    expect(globToRegExp("**/x.ts").test("x.ts")).toBe(true);
    expect(globToRegExp("**/x.ts").test("d/e/x.ts")).toBe(true);
    expect(globToRegExp("**/x.ts").test("d/e/y.ts")).toBe(false);
  });

  it("? — один символ, кроме «/»", () => {
    expect(globToRegExp("a/?.ts").test("a/b.ts")).toBe(true);
    expect(globToRegExp("a/?.ts").test("a/bb.ts")).toBe(false);
    expect(globToRegExp("a?b").test("a/b")).toBe(false);
  });

  it("остальные символы буквальны: точка — это точка", () => {
    expect(globToRegExp("a.b/c").test("aXb/c")).toBe(false);
    expect(globToRegExp("a.b/c").test("a.b/c")).toBe(true);
    expect(globToRegExp("a+(b)/c").test("a+(b)/c")).toBe(true);
  });

  it("каталог с «/» на конце — всё внутри него (так записаны миграции в shared)", () => {
    expect(globToRegExp("backend/api/prisma/migrations/").test("backend/api/prisma/migrations/2026/m.sql")).toBe(true);
    expect(globToRegExp("backend/api/prisma/migrations/").test("backend/api/prisma/schema.prisma")).toBe(false);
  });

  it("matches — хоть один шаблон из списка", () => {
    expect(matches("a/b.ts", ["x/**", "a/*.ts"])).toBe(true);
    expect(matches("a/b.ts", ["x/**"])).toBe(false);
    expect(matches("a/b.ts", [])).toBe(false);
  });
});

describe("пересечение зон", () => {
  const repoFiles = [`${SHOP}/shop.service.ts`, `${SHOP}/shop-catalog.ts`, `${WALLET}/wallet.service.ts`];

  it("каталог и файл внутри него пересекаются", () => {
    expect(zonesOverlap([`${SHOP}/**`], [`${SHOP}/shop.service.ts`], repoFiles)).toBe(true);
  });

  it("соседние каталоги не пересекаются", () => {
    expect(zonesOverlap([`${SHOP}/**`], [`${WALLET}/**`], repoFiles)).toBe(false);
  });

  it("два одинаковых новых файла, которых ещё нет в репозитории, пересекаются", () => {
    expect(zonesOverlap(["scripts/tasks/new.mjs"], ["scripts/tasks/new.mjs"], repoFiles)).toBe(true);
    expect(zonesOverlap(["scripts/tasks/new.mjs"], ["scripts/tasks/other.mjs"], repoFiles)).toBe(false);
  });
});

describe("выход за зоны", () => {
  const task = { fileName: "T-0003-x.md", zones: [`${SHOP}/**`], shared: ["docs/30-configuration-map.md"] };

  it("файлы в зонах, строка в shared и сам файл задачи — не нарушение", () => {
    expect(outOfZone([`${SHOP}/shop.service.ts`, "docs/30-configuration-map.md", "tasks/T-0003-x.md"], task)).toEqual([]);
  });

  it("файл в другом модуле — нарушение", () => {
    expect(outOfZone([`${SHOP}/shop.service.ts`, `${WALLET}/wallet.service.ts`], task)).toEqual([`${WALLET}/wallet.service.ts`]);
  });

  it("чужой файл задачи — нарушение", () => {
    expect(outOfZone(["tasks/T-0004-y.md"], task)).toEqual(["tasks/T-0004-y.md"]);
  });

  it("файл своей задачи в архиве — выход за зоны (T-0343): в PR задачи он остаётся в tasks/", () => {
    const own = { ...task, id: "T-0003", fileName: "T-0003-x.md" };
    expect(outOfZone(["tasks/archive/T-0003-x.md", "tasks/T-0003-x.md"], own)).toEqual(["tasks/archive/T-0003-x.md"]);
    expect(outOfZone(["tasks/archive/T-0004-y.md"], own)).toEqual(["tasks/archive/T-0004-y.md"]);
  });

  it("tasks/epics.md — выход за зоны: ссылки на задачи правит уборка тимлида", () => {
    expect(outOfZone(["tasks/epics.md", "tasks/README.md"], task)).toEqual(["tasks/epics.md", "tasks/README.md"]);
  });

  it("outOfZoneHint: подсказка только про tasks/ и с командой возврата файла", () => {
    expect(outOfZoneHint(["backend/x.ts"], "T-0003-x.md")).toBeNull();
    const archived = outOfZoneHint(["tasks/archive/T-0003-x.md"], "T-0003-x.md");
    expect(archived).toContain("git mv tasks/archive/T-0003-x.md tasks/T-0003-x.md");
    expect(archived).toContain("pnpm task fix");
    expect(outOfZoneHint(["tasks/epics.md"], "T-0003-x.md")).not.toBeNull();
  });
});

describe("кто держит файл (pnpm task holds)", () => {
  const working = { id: "T-0003", zones: [`${SHOP}/**`], shared: ["docs/30-configuration-map.md"] };
  const ids = (found: { task: { id: string } }[]): string[] => found.map((entry) => entry.task.id);

  it("путь в зонах и в shared найден, назван шаблон", () => {
    expect(holdingPattern(`${SHOP}/shop.service.ts`, working)).toBe(`${SHOP}/**`);
    expect(holdingPattern("docs/30-configuration-map.md", working)).toBe("docs/30-configuration-map.md");
  });

  it("чужой путь не найден", () => {
    expect(holdingPattern(`${WALLET}/wallet.service.ts`, working)).toBeNull();
    expect(holdingPattern("docs/30-configuration-map.mdx", working)).toBeNull();
  });

  it("каталог без слэша на конце и со слэшем держит задача с зоной внутри него", () => {
    expect(holdingPattern(SHOP, working)).toBe(`${SHOP}/**`);
    expect(holdingPattern(`${SHOP}/`, working)).toBe(`${SHOP}/**`);
    expect(holdingPattern("backend/api/src/modules", working)).toBe(`${SHOP}/**`);
  });

  it("путь с «./» и обратными чертами сводится к виду из зон", () => {
    expect(holdingPattern(`./${SHOP}/shop.service.ts`, working)).toBe(`${SHOP}/**`);
    expect(holdingPattern(`${SHOP.replaceAll("/", "\\")}\\shop.service.ts`, working)).toBe(`${SHOP}/**`);
  });

  it("держат задачи «в работе» и «доработка»; ready, на ревью и заблокированные — нет", () => {
    const zones = { zones: [`${SHOP}/**`], shared: [] };
    const board = {
      inProgress: [{ task: { id: "T-0001", ...zones }, pr: 12 }],
      rework: [{ task: { id: "T-0002", ...zones }, pr: 13 }],
      free: [{ task: { id: "T-0003", ...zones } }],
      review: [{ task: { id: "T-0004", ...zones }, pr: 14 }],
      blocked: [{ task: { id: "T-0005", ...zones } }],
    };
    const found = tasksHolding(`${SHOP}/shop.service.ts`, board);
    expect(ids(found)).toEqual(["T-0001", "T-0002"]);
    expect(found[0]).toMatchObject({ pr: 12, pattern: `${SHOP}/**`, where: "в работе" });
    expect(found[1]).toMatchObject({ pr: 13, where: "доработка" });
  });

  it("путь вне зон задач в работе — пусто", () => {
    const board = { inProgress: [{ task: { id: "T-0001", zones: [`${SHOP}/**`], shared: [] } }], rework: [] };
    expect(tasksHolding("README.md", board)).toEqual([]);
    expect(tasksHolding("a/b.ts", { inProgress: [], rework: [] })).toEqual([]);
  });
});
