import { create } from "zustand";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Положение радара забега (docs/35-stage4-plan.md Р113): справа сверху,
 * слева сверху или выключен. Низа нет: там радар закрывает палец на
 * джойстике. Настройка устройства, а не аккаунта: хват и размер экрана у
 * каждого телефона свои (docs/27-design-system-and-app-shell.md §7.1).
 */
const RADAR_KEY = "bh.radar.v1";

export const RADAR_POSITIONS = ["right", "left", "off"] as const;
export type RadarPosition = (typeof RADAR_POSITIONS)[number];

export const DEFAULT_RADAR_POSITION: RadarPosition = "right";

const schema = z.object({ position: z.enum(RADAR_POSITIONS) });

type Stored = z.infer<typeof schema>;

export interface RadarSettingStore {
  position: RadarPosition;
  hydrate(): void;
  set(position: RadarPosition): void;
}

export const useRadarSetting = create<RadarSettingStore>((set, get) => ({
  position: DEFAULT_RADAR_POSITION,

  hydrate(): void {
    set({ position: value().read().position });
  },

  set(position): void {
    if (get().position === position) return;
    set({ position });
    value().write({ position });
    track("settings_changed", { setting: "radar.position", value: position, scope: "device" });
  },
}));

/**
 * Классы блока радара в HUD; `null` — радар не рисуется вовсе. Отступы от
 * выреза камеры — только через `--app-inset-*`.
 */
export function radarPlacementClass(position: RadarPosition): string | null {
  switch (position) {
    case "right":
      return "flex justify-end pt-2 pr-[calc(1rem+var(--app-inset-right))]";
    case "left":
      return "flex justify-start pt-2 pl-[calc(1rem+var(--app-inset-left))]";
    case "off":
      return null;
  }
}

function value(): ReturnType<typeof createPersistedValue<Stored>> {
  return createPersistedValue<Stored>({
    storage: useShell.getState().storage,
    key: RADAR_KEY,
    schema,
    fallback: { position: DEFAULT_RADAR_POSITION },
    onBroken: (key, reason) => reportError("radar", `${key}: ${reason}`),
  });
}
