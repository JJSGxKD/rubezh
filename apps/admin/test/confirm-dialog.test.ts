import { describe, expect, it } from "vitest";
import { confirmReady } from "../src/ui/confirm-dialog";

// Кнопка окна действия (tasks/T-0050): недоступна, пока причина не годится,
// поля не годны или запрос ещё идёт.

describe("confirmReady", () => {
  it("без правила причины кнопка доступна, пока запрос не идёт", () => {
    expect(confirmReady("", undefined, false)).toBe(true);
    expect(confirmReady("", undefined, true)).toBe(false);
  });

  it("недоступна, пока поля не годны, при любой причине", () => {
    expect(confirmReady("", undefined, false, "Сумма больше остатка")).toBe(false);
    expect(confirmReady("достаточно длинная причина", { min: 3, max: 200 }, false, "нет")).toBe(false);
  });

  it("причина короче минимума после обрезки пробелов не годится", () => {
    expect(confirmReady("  ок ", { min: 3, max: 200 }, false)).toBe(false);
    expect(confirmReady("", { min: 3, max: 200 }, false)).toBe(false);
  });

  it("причина в пределах годится", () => {
    expect(confirmReady("дубль", { min: 3, max: 200 }, false)).toBe(true);
    expect(confirmReady("  дубль  ", { min: 5, max: 200 }, false)).toBe(true);
  });

  it("причина длиннее максимума не годится", () => {
    expect(confirmReady("а".repeat(11), { min: 1, max: 10 }, false)).toBe(false);
    expect(confirmReady("а".repeat(10), { min: 1, max: 10 }, false)).toBe(true);
  });

  it("пока запрос идёт, кнопка недоступна", () => {
    expect(confirmReady("дубль", { min: 3, max: 200 }, true)).toBe(false);
  });
});
