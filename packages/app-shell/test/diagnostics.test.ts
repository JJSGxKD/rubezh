import { beforeEach, describe, expect, it } from "vitest";
import type { KeyValueStorage, PlatformAdapter } from "@bh/shared-types";
import { useDiagnostics } from "../src/state/diagnostics";
import { initShell } from "../src/state/shell";

// Настройки тестировщика (docs/28-diagnostics.md §2).

const KEY = "bh.diagnostics.v1";

function mount(storage: KeyValueStorage): void {
  initShell({
    adapter: {} as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage,
    analytics: () => undefined,
    build: { version: "test", contentHash: "", platform: "web" },
  });
}

function memory(initial: Record<string, string> = {}): KeyValueStorage {
  const values = { ...initial };
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

describe("режим диагностики", () => {
  beforeEach(() => mount(memory()));

  it("запись забегов включена вместе с диагностикой по умолчанию", () => {
    useDiagnostics.getState().hydrate(true);
    expect(useDiagnostics.getState()).toMatchObject({ enabled: true, recordRuns: true });

    useDiagnostics.getState().hydrate(false);
    expect(useDiagnostics.getState()).toMatchObject({ enabled: false, recordRuns: false });
  });

  it("выбор тестера сильнее умолчания сборки", () => {
    mount(memory({ [KEY]: JSON.stringify({ enabled: true, recordRuns: false, fpsOverlay: false }) }));
    useDiagnostics.getState().hydrate(true);
    expect(useDiagnostics.getState().recordRuns).toBe(false);
  });
});
