import { create } from "zustand";
import { z } from "zod/v4-mini";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Настройки тестировщика (docs/28-diagnostics.md §2). Выключены по умолчанию:
 * обычный игрок не должен видеть ни seed, ни витрину компонентов.
 */
const DIAGNOSTICS_KEY = "bh.diagnostics.v1";

const schema = z.object({
  enabled: z.boolean(),
  recordRuns: z.boolean(),
  fpsOverlay: z.boolean(),
});

export type DiagnosticsState = z.infer<typeof schema>;

export interface DiagnosticsStore extends DiagnosticsState {
  hydrate(): void;
  toggle(key: keyof DiagnosticsState): void;
}

export const useDiagnostics = create<DiagnosticsStore>((set, get) => ({
  enabled: false,
  recordRuns: false,
  fpsOverlay: false,

  hydrate(): void {
    set(value().read());
  },

  toggle(key): void {
    const next = !get()[key];
    if (key === "enabled") set({ enabled: next });
    else if (key === "recordRuns") set({ recordRuns: next });
    else set({ fpsOverlay: next });

    const state = get();
    value().write({
      enabled: state.enabled,
      recordRuns: state.recordRuns,
      fpsOverlay: state.fpsOverlay,
    });
    track(key === "enabled" ? "diagnostics_mode_changed" : "settings_changed", {
      setting: key,
      value: next,
    });
  },
}));

function value(): ReturnType<typeof createPersistedValue<DiagnosticsState>> {
  return createPersistedValue<DiagnosticsState>({
    storage: useShell.getState().storage,
    key: DIAGNOSTICS_KEY,
    schema,
    fallback: { enabled: false, recordRuns: false, fpsOverlay: false },
    onBroken: (key, reason) => reportError("diagnostics", `${key}: ${reason}`),
  });
}
