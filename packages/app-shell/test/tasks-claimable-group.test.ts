import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Заголовок группы «Можно забрать» (tasks/T-0373, Р186) — по ключу словаря.

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const dictionary = JSON.parse(read("../src/i18n/ru-tasks.json")) as Record<string, string>;

describe("группа «Можно забрать»", () => {
  it("ключ словаря — дословно «Можно забрать»", () => {
    expect(dictionary["tasks.claimableGroup"]).toBe("Можно забрать");
  });

  it("заголовок группы заданий и достижений берётся этим ключом", () => {
    expect(read("../src/screens/meta/tasks.tsx")).toContain('t("tasks.claimableGroup")');
    expect(read("../src/screens/meta/achievements.tsx")).toContain('t("tasks.claimableGroup")');
  });
});
