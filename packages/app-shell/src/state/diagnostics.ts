import { create } from "zustand";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Настройки тестировщика (docs/28-diagnostics.md §2). Выключены по умолчанию:
 * обычный игрок не должен видеть ни seed, ни витрину компонентов.
 */
const DIAGNOSTICS_KEY = "bh.diagnostics.v1";

const schema = z.object({
  /**
   * `null` — игрок ещё не трогал переключатель, берётся умолчание сборки. На
   * время закрытого теста оно включено: тестеру не нужно лезть в настройки,
   * чтобы отчёт о баге содержал seed. В сборке для игроков умолчание
   * выключено, а переключатель остаётся — выключить можно всегда.
   */
  enabled: z.nullable(z.boolean()),
  recordRuns: z.boolean(),
  fpsOverlay: z.boolean(),
});

type StoredDiagnostics = z.infer<typeof schema>;

export interface DiagnosticsState {
  enabled: boolean;
  recordRuns: boolean;
  fpsOverlay: boolean;
}

export interface DiagnosticsStore extends DiagnosticsState {
  hydrate(defaultEnabled: boolean): void;
  toggle(key: keyof DiagnosticsState): void;
}

export const useDiagnostics = create<DiagnosticsStore>((set, get) => ({
  enabled: false,
  recordRuns: false,
  fpsOverlay: false,

  hydrate(defaultEnabled: boolean): void {
    const stored = value().read();
    set({
      enabled: stored.enabled ?? defaultEnabled,
      recordRuns: stored.recordRuns,
      fpsOverlay: stored.fpsOverlay,
    });
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

function value(): ReturnType<typeof createPersistedValue<StoredDiagnostics>> {
  return createPersistedValue<StoredDiagnostics>({
    storage: useShell.getState().storage,
    key: DIAGNOSTICS_KEY,
    schema,
    fallback: { enabled: null, recordRuns: false, fpsOverlay: false },
    onBroken: (key, reason) => reportError("diagnostics", `${key}: ${reason}`),
  });
}
