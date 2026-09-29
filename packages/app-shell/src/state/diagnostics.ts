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
  /**
   * `null` — не трогал: запись идёт вместе с умолчанием диагностики. Тестер,
   * которому диагностику включили за него, должен присылать и запись забега,
   * а не узнавать о переключателе, когда баг уже случился.
   */
  recordRuns: z.nullable(z.boolean()),
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
  /** значение с другого устройства аккаунта (`account-settings.ts`) — не выбор игрока здесь */
  applyAccount(values: Partial<Pick<DiagnosticsState, "enabled" | "recordRuns">>): void;
}

export const useDiagnostics = create<DiagnosticsStore>((set, get) => ({
  enabled: false,
  recordRuns: false,
  fpsOverlay: false,

  hydrate(defaultEnabled: boolean): void {
    const stored = value().read();
    set({
      enabled: stored.enabled ?? defaultEnabled,
      recordRuns: stored.recordRuns ?? defaultEnabled,
      fpsOverlay: stored.fpsOverlay,
    });
  },

  toggle(key): void {
    const next = !get()[key];
    if (key === "enabled") set({ enabled: next });
    else if (key === "recordRuns") set({ recordRuns: next });
    else set({ fpsOverlay: next });

    save({ [key]: next });
    // Участие в тестировании и запись забегов — за аккаунтом, счётчик кадров
    // — у устройства: на слабом телефоне он лишний, даже если на ПК включён.
    if (key === "enabled") track("diagnostics_mode_changed", { setting: key, value: next });
    else track("settings_changed", { setting: key, value: next, scope: key === "fpsOverlay" ? "device" : "account" });
    if (key !== "fpsOverlay") {
      void import("./account-settings").then(({ noteAccountSetting }) => noteAccountSetting(key === "enabled" ? "testing.enabled" : "testing.recordRuns", next));
    }
  },

  applyAccount(values): void {
    set(values);
    save(values);
  },
}));

/**
 * Сохранить только тронутое: нетронутый ключ остаётся `null` и следует
 * умолчанию сборки, даже когда игрок переключил соседний.
 */
function save(patch: Partial<DiagnosticsState>): void {
  value().write({ ...value().read(), ...patch });
}

function value(): ReturnType<typeof createPersistedValue<StoredDiagnostics>> {
  return createPersistedValue<StoredDiagnostics>({
    storage: useShell.getState().storage,
    key: DIAGNOSTICS_KEY,
    schema,
    fallback: { enabled: null, recordRuns: null, fpsOverlay: false },
    onBroken: (key, reason) => reportError("diagnostics", `${key}: ${reason}`),
  });
}
