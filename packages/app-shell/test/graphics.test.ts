import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import { useFlags } from "../src/state/flags";
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
    expect(runGraphics()).toEqual({ telegraphs: true, weaponEffects: true, damageNumbers: true, art: false });
  });

  it("выбор игрока переживает перезапуск и попадает в аналитику", () => {
    useGraphics.getState().toggle("telegraphs");
    expect(events.at(-1)).toEqual({ event: "settings_changed", payload: { setting: "graphics.telegraphs", value: false, scope: "account" } });
    useGraphics.getState().toggle("weaponEffects");
    expect(events.at(-1)).toEqual({ event: "settings_changed", payload: { setting: "graphics.weaponEffects", value: false, scope: "device" } });
    useGraphics.getState().toggle("weaponEffects");

    mount();
    expect(runGraphics().telegraphs).toBe(false);
    expect(runGraphics().weaponEffects).toBe(true);
  });

  it("живой фон включён по умолчанию, выключается на устройстве и переживает перезапуск", () => {
    expect(useGraphics.getState().liveBackground).toBe(true);
    useGraphics.getState().toggle("liveBackground");
    expect(events.at(-1)).toEqual({ event: "settings_changed", payload: { setting: "graphics.liveBackground", value: false, scope: "device" } });

    mount();
    expect(useGraphics.getState().liveBackground).toBe(false);
    // В забег он не уходит: фона во время забега нет.
    expect(runGraphics()).toEqual({ telegraphs: true, weaponEffects: true, damageNumbers: true, art: false });
  });

  it("сохранённое до «Живого фона» не сбрасывается: фон читается включённым", () => {
    storage.values[KEY] = JSON.stringify({ telegraphs: false, weaponEffects: true, damageNumbers: true });
    mount();
    expect(runGraphics().telegraphs).toBe(false);
    expect(useGraphics.getState().liveBackground).toBe(true);
  });

  it("битое значение в хранилище сбрасывается к умолчанию, а не роняет запуск", () => {
    storage.values[KEY] = JSON.stringify({ telegraphs: "нет" });
    mount();
    expect(useGraphics.getState()).toMatchObject(DEFAULT_GRAPHICS);
    expect(storage.values[KEY]).toBeUndefined();
  });

  describe("новый облик боя", () => {
    function grant(): void {
      useFlags.setState({ flags: { "art.sprites": true }, tester: false });
    }

    it("без доступа арт не идёт в забег при любой настройке", () => {
      expect(useGraphics.getState().art).toBe(true);
      expect(runGraphics().art).toBe(false);
      useGraphics.getState().toggle("art");
      useGraphics.getState().toggle("art");
      expect(useGraphics.getState().art).toBe(true);
      expect(runGraphics().art).toBe(false);
    });

    it("с доступом по умолчанию включён и уходит в забег", () => {
      grant();
      expect(runGraphics().art).toBe(true);
    });

    it("игрок выключает его: выбор живёт на устройстве, идёт в аналитику и переживает перезапуск", () => {
      grant();
      useGraphics.getState().toggle("art");
      expect(events.at(-1)).toEqual({ event: "settings_changed", payload: { setting: "graphics.art", value: false, scope: "device" } });
      expect(runGraphics().art).toBe(false);

      mount();
      grant();
      expect(useGraphics.getState().art).toBe(false);
      expect(runGraphics().art).toBe(false);
    });

    it("сохранённое до поля art читается с включённым артом, а не сбрасывается", () => {
      storage.values[KEY] = JSON.stringify({ telegraphs: false, weaponEffects: true, damageNumbers: true, liveBackground: false });
      mount();
      grant();
      expect(useGraphics.getState()).toMatchObject({ art: true, telegraphs: false, liveBackground: false });
      expect(runGraphics().art).toBe(true);
    });
  });
});
