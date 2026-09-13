import type { ScreenMode } from "@bh/shared-types";
import { create } from "zustand";
import { z } from "zod/v4-mini";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Настройки игрока: режим экрана, звук, музыка, вибрация
 * (docs/27-design-system-and-app-shell.md §7).
 *
 * Режим экрана хранится и применяется при каждом запуске: бот может быть
 * настроен на fullscreen, а игрок его выключил — тогда приложение сразу
 * выходит из полноэкранного режима, и наоборот (§5.2.1).
 */
const SETTINGS_KEY = "bh.settings.v1";

const schema = z.object({
  /**
   * `null` — игрок ещё не выбирал, берётся умолчание площадки. Без этого
   * различия осознанный выбор «обычный режим» был бы неотличим от отсутствия
   * выбора, и на телефоне его каждый раз перебивал бы полноэкранный.
   */
  screenMode: z.nullable(z.enum(["fullscreen", "normal"])),
  sound: z.boolean(),
  music: z.boolean(),
  haptics: z.boolean(),
});

type StoredSettings = z.infer<typeof schema>;

export interface SettingsState {
  screenMode: ScreenMode;
  sound: boolean;
  music: boolean;
  haptics: boolean;
}

export interface SettingsStore extends SettingsState {
  /** умолчание площадки, пока игрок ничего не выбирал */
  hydrate(defaultScreenMode: ScreenMode): void;
  setScreenMode(mode: ScreenMode): Promise<void>;
  /** режим сменился снаружи: жестом или кнопкой Telegram */
  syncScreenMode(mode: ScreenMode): void;
  toggle(key: "sound" | "music" | "haptics"): void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  screenMode: "normal",
  sound: true,
  music: true,
  haptics: true,

  hydrate(defaultScreenMode: ScreenMode): void {
    const stored = value().read();
    const mode = stored.screenMode ?? defaultScreenMode;
    set({ sound: stored.sound, music: stored.music, haptics: stored.haptics, screenMode: mode });
    void get().setScreenMode(mode);
  },

  async setScreenMode(mode: ScreenMode): Promise<void> {
    const ui = useShell.getState().adapter.ui;
    // Возвращается фактический режим, а не запрошенный: клиент вправе
    // отказать, и переключатель обязан показывать то, что игрок видит.
    const applied = await ui.setScreenMode(mode).catch((error: unknown) => {
      reportError("settings", `смена режима экрана: ${String(error)}`);
      return ui.screenMode;
    });

    if (applied !== get().screenMode) {
      track("settings_changed", { setting: "screenMode", value: applied });
    }
    set({ screenMode: applied });
    persist(get());
  },

  syncScreenMode(mode: ScreenMode): void {
    if (mode === get().screenMode) return;
    set({ screenMode: mode });
    persist(get());
    track("settings_changed", { setting: "screenMode", value: mode, source: "platform" });
  },

  toggle(key): void {
    const next = !get()[key];
    // Ветки вместо вычисляемого ключа с приведением типа: приведений в
    // проекте не любят, а переключателей всего три.
    if (key === "sound") set({ sound: next });
    else if (key === "music") set({ music: next });
    else set({ haptics: next });

    persist(get());
    track("settings_changed", { setting: key, value: next });
  },
}));

function value(): ReturnType<typeof createPersistedValue<StoredSettings>> {
  return createPersistedValue<StoredSettings>({
    storage: useShell.getState().storage,
    key: SETTINGS_KEY,
    schema,
    fallback: { screenMode: null, sound: true, music: true, haptics: true },
    onBroken: (key, reason) => reportError("settings", `${key}: ${reason}`),
  });
}

function persist(state: SettingsState): void {
  value().write({
    screenMode: state.screenMode,
    sound: state.sound,
    music: state.music,
    haptics: state.haptics,
  });
}
