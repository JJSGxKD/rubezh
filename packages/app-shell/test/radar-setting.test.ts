import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import { DEFAULT_RADAR_POSITION, radarPlacementClass, useRadarSetting } from "../src/state/radar-setting";
import { initShell } from "../src/state/shell";

// Положение радара (docs/35-stage4-plan.md Р113): настройка устройства, по
// умолчанию справа сверху; внизу радара нет ни при каком значении.

const KEY = "bh.radar.v1";

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

function mount(withStorage = true): void {
  events = [];
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    ...(withStorage ? { storage } : {}),
    analytics: (event, payload) => events.push({ event, payload }),
    build: { version: "test", contentHash: "", platform: "web" },
  } as Parameters<typeof initShell>[0]);
  useRadarSetting.setState({ position: DEFAULT_RADAR_POSITION });
  useRadarSetting.getState().hydrate();
}

describe("положение радара", () => {
  beforeEach(() => {
    storage = memoryStorage();
    mount();
  });

  it("по умолчанию — справа сверху", () => {
    expect(useRadarSetting.getState().position).toBe("right");
  });

  it("выбор переживает перезапуск", () => {
    useRadarSetting.getState().set("left");
    mount();
    expect(useRadarSetting.getState().position).toBe("left");
  });

  it("битый JSON и значение вне списка — умолчание, ключ стёрт", () => {
    storage.values[KEY] = "{не json";
    mount();
    expect(useRadarSetting.getState().position).toBe("right");
    expect(storage.values[KEY]).toBeUndefined();

    storage.values[KEY] = JSON.stringify({ position: "bottom" });
    mount();
    expect(useRadarSetting.getState().position).toBe("right");
    expect(storage.values[KEY]).toBeUndefined();
  });

  it("смена шлёт одно settings_changed, повтор того же значения — ничего", () => {
    useRadarSetting.getState().set("off");
    expect(events).toEqual([{ event: "settings_changed", payload: { setting: "radar.position", value: "off", scope: "device" } }]);

    useRadarSetting.getState().set("off");
    expect(events).toHaveLength(1);
  });

  it("без хранилища не падает, значение держится в памяти", () => {
    mount(false);
    expect(() => useRadarSetting.getState().set("left")).not.toThrow();
    expect(useRadarSetting.getState().position).toBe("left");
  });
});

describe("классы положения радара", () => {
  it("справа — по правому краю с отступом выреза", () => {
    const classes = radarPlacementClass("right") ?? "";
    expect(classes).toContain("justify-end");
    expect(classes).toContain("--app-inset-right");
  });

  it("слева — по левому краю с отступом выреза", () => {
    const classes = radarPlacementClass("left") ?? "";
    expect(classes).toContain("justify-start");
    expect(classes).toContain("--app-inset-left");
  });

  it("выключен — не рисовать", () => {
    expect(radarPlacementClass("off")).toBeNull();
  });
});
