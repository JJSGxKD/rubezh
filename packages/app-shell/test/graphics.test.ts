import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import { DEFAULT_GRAPHICS, runGraphics, useGraphics } from "../src/state/graphics";
import { initShell } from "../src/state/shell";

// Настройки графики (docs/27-design-system-and-app-shell.md §8): по умолчанию
// включено всё, выбор игрока переживает перезапуск и уходит в забег.

const KEY = "bh.graphics.v1";

function memoryStorage(): KeyValueStorage & { values: Record<string, string> } {
  const values: Record<string, string> = {};
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

let storage = memoryStorage();
let events: { event: string; payload: Record<string, unknown> }[] = [];

function mount(): void {
  events = [];
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage,
    analytics: (event, payload) => events.push({ event, payload }),
    build: { version: "test", contentHash: "", platform: "web" },
  });
  useGraphics.setState({ ...DEFAULT_GRAPHICS });
  useGraphics.getState().hydrate();
}

describe("настройки графики", () => {
  beforeEach(() => {
    storage = memoryStorage();
    mount();
  });

  it("по умолчанию рисуется всё: телеграфы и эффекты — способ прочитать бой", () => {
    expect(runGraphics()).toEqual({ telegraphs: true, weaponEffects: true, damageNumbers: true });
  });

  it("выбор игрока переживает перезапуск и попадает в аналитику", () => {
    useGraphics.getState().toggle("telegraphs");
    expect(events.at(-1)).toEqual({ event: "settings_changed", payload: { setting: "graphics.telegraphs", value: false } });

    mount();
    expect(runGraphics().telegraphs).toBe(false);
    expect(runGraphics().weaponEffects).toBe(true);
  });

  it("битое значение в хранилище сбрасывается к умолчанию, а не роняет запуск", () => {
    storage.values[KEY] = JSON.stringify({ telegraphs: "нет" });
    mount();
    expect(runGraphics()).toEqual(DEFAULT_GRAPHICS);
    expect(storage.values[KEY]).toBeUndefined();
  });
});
