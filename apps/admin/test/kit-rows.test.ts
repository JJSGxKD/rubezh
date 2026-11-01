import { describe, expect, it } from "vitest";
import { blockedReason } from "../src/ui/kit";

// Причина у недоступной главной кнопки (tasks/T-0357): показывается, только когда кнопка выключена и причина не пуста.

describe("причина у недоступной кнопки", () => {
  it("кнопка выключена и причина есть — причина", () => {
    expect(blockedReason(true, "нужен id")).toBe("нужен id");
  });

  it("кнопка активна — причины нет, даже если она передана", () => {
    expect(blockedReason(false, "нужен id")).toBeNull();
    expect(blockedReason(undefined, "нужен id")).toBeNull();
  });

  it("пустая причина или пробелы — причины нет", () => {
    expect(blockedReason(true, null)).toBeNull();
    expect(blockedReason(true, undefined)).toBeNull();
    expect(blockedReason(true, "  ")).toBeNull();
  });

  it("лишние пробелы по краям обрезаются", () => {
    expect(blockedReason(true, "  нужен id ")).toBe("нужен id");
  });
});
