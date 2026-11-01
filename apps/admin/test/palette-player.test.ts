import { describe, expect, it } from "vitest";
import { playerQuery } from "../src/routes";

// Поиск игрока из поиска разделов «/» (tasks/T-0355): когда запрос похож на игрока.

describe("запрос, похожий на игрока", () => {
  it("«@ник» — игрок; пробелы по краям обрезаются", () => {
    expect(playerQuery("@dym")).toBe("@dym");
    expect(playerQuery(" @dym ")).toBe("@dym");
  });

  it("«@» и одна буква после него — ещё не игрок", () => {
    expect(playerQuery("@")).toBeNull();
    expect(playerQuery("@d")).toBeNull();
    expect(playerQuery("@dy")).toBe("@dy");
  });

  it("число от 5 до 20 цифр — Telegram ID", () => {
    expect(playerQuery("123456789")).toBe("123456789");
    expect(playerQuery("12345")).toBe("12345");
    expect(playerQuery("1".repeat(20))).toBe("1".repeat(20));
  });

  it("короткое число, версия, дата, слишком длинное число — не игрок", () => {
    expect(playerQuery("1234")).toBeNull();
    expect(playerQuery("0.9.1")).toBeNull();
    expect(playerQuery("2026-11-01")).toBeNull();
    expect(playerQuery("1".repeat(21))).toBeNull();
  });

  it("имя раздела и пустой запрос — не игрок", () => {
    expect(playerQuery("рассылки")).toBeNull();
    expect(playerQuery("")).toBeNull();
    expect(playerQuery("   ")).toBeNull();
  });
});
