import { describe, expect, it } from "vitest";
import { isDirty } from "../src/ui/form-dialog";

// Окно формы (tasks/T-0356): несохранённое не теряется, сравнение по значениям.

describe("isDirty", () => {
  it("порядок ключей не важен", () => {
    expect(isDirty({ a: 1, b: "x" }, { b: "x", a: 1 })).toBe(false);
  });

  it("изменённое значение — грязная форма", () => {
    expect(isDirty({ a: 1 }, { a: 2 })).toBe(true);
  });

  it("вложенные значения сравниваются по значению", () => {
    expect(isDirty({ r: { coins: 5 } }, { r: { coins: 5 } })).toBe(false);
    expect(isDirty({ r: { coins: 5 } }, { r: { coins: 6 } })).toBe(true);
  });

  it("null и пустая строка различаются", () => {
    expect(isDirty({ t: null }, { t: "" })).toBe(true);
  });
});
