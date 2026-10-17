import { describe, expect, it } from "vitest";
import arsenal from "../src/i18n/ru-arsenal.json";

// Подсказки к параметрам снаряжения (tasks/T-0136): у каждого параметра есть
// пояснение рядом с названием, не пустое и не длиннее 120 знаков.
const dictionary = arsenal as Record<string, string>;
const STAT_NAME = /^item\.stat\.[^.]+$/;
const statKeys = Object.keys(dictionary).filter((key) => STAT_NAME.test(key));

describe("подсказки к параметрам снаряжения", () => {
  it("у каждого параметра есть ключ подсказки", () => {
    const missing = statKeys.filter((key) => !(`${key}.hint` in dictionary));
    expect(missing).toEqual([]);
  });

  it("подсказка не пустая и не длиннее 120 знаков", () => {
    for (const key of statKeys) {
      const hint = dictionary[`${key}.hint`] ?? "";
      expect(hint.trim(), key).not.toBe("");
      expect(hint.length, key).toBeLessThanOrEqual(120);
    }
  });

  it("ключей подсказок не больше, чем параметров — лишних нет", () => {
    const hintKeys = Object.keys(dictionary).filter((key) => key.startsWith("item.stat.") && key.endsWith(".hint"));
    expect(hintKeys).toHaveLength(statKeys.length);
  });
});
