import type { KeyValueStorage } from "@bh/shared-types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4-mini";
import { createPersistedValue, readNumber } from "../src/state/persisted";

/**
 * Чтение хранилища (docs/27-design-system-and-app-shell.md §7, §9).
 *
 * Данные из хранилища — граница системы: их писала предыдущая версия
 * приложения, их мог испортить приватный режим. Битое значение обязано
 * сбрасываться к умолчанию, а не ронять запуск.
 */
const schema = z.object({ sound: z.boolean(), volume: z.number() });
const FALLBACK = { sound: true, volume: 1 };

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

describe("значение в хранилище устройства", () => {
  it("читает записанное", () => {
    const storage = memoryStorage();
    const value = createPersistedValue({ storage, key: "k", schema, fallback: FALLBACK });

    value.write({ sound: false, volume: 0.5 });
    expect(value.read()).toEqual({ sound: false, volume: 0.5 });
  });

  it("сбрасывает значение, которое не разбирается как JSON", () => {
    const storage = memoryStorage({ k: "{битое" });
    const onBroken = vi.fn();
    const value = createPersistedValue({ storage, key: "k", schema, fallback: FALLBACK, onBroken });

    expect(value.read()).toEqual(FALLBACK);
    expect(storage.values["k"]).toBeUndefined();
    expect(onBroken).toHaveBeenCalledOnce();
  });

  it("сбрасывает значение от старой версии схемы", () => {
    // Так выглядит запись предыдущей сборки: поля переименовались.
    const storage = memoryStorage({ k: JSON.stringify({ soundOn: true }) });
    const onBroken = vi.fn();
    const value = createPersistedValue({ storage, key: "k", schema, fallback: FALLBACK, onBroken });

    expect(value.read()).toEqual(FALLBACK);
    expect(onBroken).toHaveBeenCalledOnce();
  });

  it("живёт без хранилища: настройки не переживут запуск, но приложение не упадёт", () => {
    const value = createPersistedValue({
      storage: undefined,
      key: "k",
      schema,
      fallback: FALLBACK,
    });

    expect(value.read()).toEqual(FALLBACK);
    expect(() => value.write({ sound: false, volume: 0 })).not.toThrow();
  });
});

describe("одиночное число в хранилище", () => {
  it("не верит невозможному значению и стирает его", () => {
    const storage = memoryStorage({ best: "999999999" });
    expect(readNumber(storage, "best", 86_400)).toBe(0);
    expect(storage.values["best"]).toBeUndefined();
  });

  it("не верит нечисловому значению", () => {
    expect(readNumber(memoryStorage({ best: "полтора часа" }), "best", 86_400)).toBe(0);
  });

  it("возвращает правдоподобное как есть", () => {
    expect(readNumber(memoryStorage({ best: "185.4" }), "best", 86_400)).toBe(185.4);
  });
});
