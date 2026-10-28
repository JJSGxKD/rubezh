import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { globToRegExp, matches, outOfZone, outOfZoneHint, zonesOverlap } from "../tasks/zones.mjs";

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
