import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { globToRegExp, matches, outOfZone, zonesOverlap } from "../tasks/zones.mjs";

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
});
