import type { ScreenMode } from "@bh/shared-types";
import { create } from "zustand";
import { z } from "zod/mini";
import { DEFAULT_VOLUMES, type AudioVolumes } from "../audio";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Настройки игрока: режим экрана, громкость, вибрация
 * (docs/27-design-system-and-app-shell.md §7).
 *
 * Режим экрана хранится и применяется при каждом запуске: бот может быть
 * настроен на fullscreen, а игрок его выключил — тогда приложение сразу
 * выходит из полноэкранного режима, и наоборот (§5.2.1).
 */
const SETTINGS_KEY = "bh.settings.v1";

const volume = z.number().check(z.minimum(0), z.maximum(100));

const schema = z.object({
  /**
   * `null` — игрок ещё не выбирал, берётся умолчание площадки. Без этого
   * различия осознанный выбор «обычный режим» был бы неотличим от отсутствия
   * выбора, и на телефоне его каждый раз перебивал бы полноэкранный.
   */
  screenMode: z.nullable(z.enum(["fullscreen", "normal"])),
  /**
   * Громкость по регуляторам (docs/31-audio-and-haptics.md). Нет поля —
   * настройки сборки до звука: тогда учитываются прежние выключатели звука и
   * музыки, чтобы выключенное игроком не заиграло после обновления.
   */
  volumes: z.optional(z.object({ master: volume, effects: volume, ui: volume, music: volume })),
  sound: z.optional(z.boolean()),
  music: z.optional(z.boolean()),
  haptics: z.boolean(),
});

type StoredSettings = z.infer<typeof schema>;

export type VolumeKey = keyof AudioVolumes;

export interface SettingsState {
  screenMode: ScreenMode;
  volumes: AudioVolumes;
  haptics: boolean;
}

export interface SettingsStore extends SettingsState {
  /** умолчание площадки, пока игрок ничего не выбирал */
  hydrate(defaultScreenMode: ScreenMode): void;
  setScreenMode(mode: ScreenMode): Promise<void>;
  /** режим сменился снаружи: жестом или кнопкой Telegram */
  syncScreenMode(mode: ScreenMode): void;
  /** движение регулятора — применяется сразу, в аналитику не пишется */
  setVolume(key: VolumeKey, value: number): void;
  /** регулятор отпущен — одно событие аналитики на одно решение игрока */
  commitVolume(key: VolumeKey): void;
  toggle(key: "haptics"): void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  screenMode: "normal",
  volumes: DEFAULT_VOLUMES,
  haptics: true,

  hydrate(defaultScreenMode: ScreenMode): void {
    const stored = value().read();
    const mode = stored.screenMode ?? defaultScreenMode;
    set({ volumes: volumesOf(stored), haptics: stored.haptics, screenMode: mode });
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

  setVolume(key, next): void {
    const clamped = Math.round(Math.max(0, Math.min(100, next)));
    if (get().volumes[key] === clamped) return;
    set({ volumes: { ...get().volumes, [key]: clamped } });
    persist(get());
  },

  commitVolume(key): void {
    track("settings_changed", { setting: `volume.${key}`, value: get().volumes[key] });
  },

  toggle(key): void {
    const next = !get()[key];
    set({ haptics: next });
    persist(get());
    track("settings_changed", { setting: key, value: next });
  },
}));

function volumesOf(stored: StoredSettings): AudioVolumes {
  if (stored.volumes !== undefined) return stored.volumes;
  return {
    ...DEFAULT_VOLUMES,
    effects: stored.sound === false ? 0 : DEFAULT_VOLUMES.effects,
    ui: stored.sound === false ? 0 : DEFAULT_VOLUMES.ui,
    music: stored.music === false ? 0 : DEFAULT_VOLUMES.music,
  };
}

function value(): ReturnType<typeof createPersistedValue<StoredSettings>> {
  return createPersistedValue<StoredSettings>({
    storage: useShell.getState().storage,
    key: SETTINGS_KEY,
    schema,
    fallback: { screenMode: null, haptics: true },
    onBroken: (key, reason) => reportError("settings", `${key}: ${reason}`),
  });
}

function persist(state: SettingsState): void {
  value().write({
    screenMode: state.screenMode,
    volumes: state.volumes,
    haptics: state.haptics,
  });
}
