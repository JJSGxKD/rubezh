import type { RunGraphicsOptions } from "@bh/core-game";
import { create } from "zustand";
import { z } from "zod/mini";
import { createPersistedValue } from "./persisted";
import { reportError, track, useShell } from "./shell";

/**
 * Настройки графики забега (docs/27-design-system-and-app-shell.md §8).
 *
 * Всё включено по умолчанию: телеграфы и эффекты — не украшение, а способ
 * прочитать бой. Выключатели нужны там, где устройство не тянет или где
 * эффекты мешают лично игроку, и экран честно предупреждает, что ощущение от
 * игры поменяется.
 */
const GRAPHICS_KEY = "bh.graphics.v1";

const schema = z.object({
  telegraphs: z.boolean(),
  weaponEffects: z.boolean(),
  damageNumbers: z.boolean(),
});

export type GraphicsSettings = z.infer<typeof schema>;
export type GraphicsKey = keyof GraphicsSettings;

export const DEFAULT_GRAPHICS: GraphicsSettings = { telegraphs: true, weaponEffects: true, damageNumbers: true };

export interface GraphicsStore extends GraphicsSettings {
  hydrate(): void;
  toggle(key: GraphicsKey): void;
}

export const useGraphics = create<GraphicsStore>((set, get) => ({
  ...DEFAULT_GRAPHICS,

  hydrate(): void {
    set(value().read());
  },

  toggle(key): void {
    const next = !get()[key];
    set({ [key]: next } as Pick<GraphicsSettings, GraphicsKey>);
    const state = get();
    value().write({ telegraphs: state.telegraphs, weaponEffects: state.weaponEffects, damageNumbers: state.damageNumbers });
    track("settings_changed", { setting: `graphics.${key}`, value: next });
  },
}));

/** Что передать движку на старте забега. */
export function runGraphics(): RunGraphicsOptions {
  const { telegraphs, weaponEffects, damageNumbers } = useGraphics.getState();
  return { telegraphs, weaponEffects, damageNumbers };
}

function value(): ReturnType<typeof createPersistedValue<GraphicsSettings>> {
  return createPersistedValue<GraphicsSettings>({
    storage: useShell.getState().storage,
    key: GRAPHICS_KEY,
    schema,
    fallback: DEFAULT_GRAPHICS,
    onBroken: (key, reason) => reportError("graphics", `${key}: ${reason}`),
  });
}
