import { describe, expect, it } from "vitest";
import { isVersionAtLeast } from "../src/state/platform-version";

/**
 * Минимальная версия клиента площадки (docs/34-stage3-plan.md, Р11).
 * Ошибка здесь стоит дорого в обе стороны: слишком строго — игрок видит
 * «обновитесь» на исправном клиенте, слишком мягко — приложение закрывается
 * у него посреди забега.
 */

describe("сравнение версий клиента площадки", () => {
  it("равная версия годится", () => {
    expect(isVersionAtLeast("7.7", "7.7")).toBe(true);
  });

  it("более новая годится", () => {
    expect(isVersionAtLeast("8.0", "7.7")).toBe(true);
    expect(isVersionAtLeast("7.8", "7.7")).toBe(true);
  });

  it("старая не годится", () => {
    expect(isVersionAtLeast("7.6", "7.7")).toBe(false);
    expect(isVersionAtLeast("6.9", "7.7")).toBe(false);
  });

  it("считает числами, а не строками", () => {
    // Строкой «7.10» меньше «7.7» — и целая ветка клиентов получила бы экран
    // обновления на исправной версии.
    expect(isVersionAtLeast("7.10", "7.7")).toBe(true);
    expect(isVersionAtLeast("10.0", "9.1")).toBe(true);
  });

  it("разная длина номера сравнивается по частям", () => {
    expect(isVersionAtLeast("7", "7.0")).toBe(true);
    expect(isVersionAtLeast("7", "7.1")).toBe(false);
    expect(isVersionAtLeast("7.7.1", "7.7")).toBe(true);
  });

  it("неизвестная версия не блокирует: вне площадки её нет вовсе", () => {
    expect(isVersionAtLeast(null, "7.7")).toBe(true);
    expect(isVersionAtLeast(undefined, "7.7")).toBe(true);
    expect(isVersionAtLeast("", "7.7")).toBe(true);
  });

  it("мусор вместо версии не блокирует: это не повод запереть игрока", () => {
    expect(isVersionAtLeast("неизвестно", "7.7")).toBe(true);
    expect(isVersionAtLeast("7.x", "7.7")).toBe(true);
  });
});
