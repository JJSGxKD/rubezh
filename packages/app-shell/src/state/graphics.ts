import type { RunGraphicsOptions } from "@bh/core-game";
import { create } from "zustand";
import { z } from "zod/mini";
import { draftArtAllowed } from "./flags";
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

// «Живой фон» и «Новый облик боя» пришли позже остальных: у сохранённых раньше
// их нет, и это не повод сбрасывать выбранное — отсутствие читается как
// «включён».
const schema = z.object({
  telegraphs: z.boolean(),
  weaponEffects: z.boolean(),
  damageNumbers: z.boolean(),
  liveBackground: z.optional(z.boolean()),
  art: z.optional(z.boolean()),
});

export interface GraphicsSettings {
  telegraphs: boolean;
  weaponEffects: boolean;
  damageNumbers: boolean;
  /** живой фон меню, блик «Играть» и блеск редких предметов (Р145) — у устройства */
  liveBackground: boolean;
  /**
   * «Новый облик боя»: черновой арт вместо фигур — у устройства. Строка в
   * «Графике» видна только игроку с доступом (`flags.ts`), а в забег арт
   * уходит, когда доступ есть и выключатель включён.
   */
  art: boolean;
}
export type GraphicsKey = keyof GraphicsSettings;

export const DEFAULT_GRAPHICS: GraphicsSettings = { telegraphs: true, weaponEffects: true, damageNumbers: true, liveBackground: true, art: true };

export interface GraphicsStore extends GraphicsSettings {
  hydrate(): void;
  toggle(key: GraphicsKey): void;
  /** выбранное на другом устройстве аккаунта (`account-settings.ts`) */
  applyAccount(values: Partial<Pick<GraphicsSettings, "telegraphs" | "damageNumbers">>): void;
}

/**
 * Как читать бой — за аккаунтом: телеграфы и цифры урона игрок выбирает для
 * себя. Эффекты оружия — у устройства: их выключают, когда телефон не тянет.
 */
const ACCOUNT_KEYS: Partial<Record<GraphicsKey, "combat.telegraphs" | "combat.damageNumbers">> = {
  telegraphs: "combat.telegraphs",
  damageNumbers: "combat.damageNumbers",
};

export const useGraphics = create<GraphicsStore>((set, get) => ({
  ...DEFAULT_GRAPHICS,

  hydrate(): void {
    const stored = value().read();
    set({ ...stored, liveBackground: stored.liveBackground ?? true, art: stored.art ?? true });
    markLiveBackground(get().liveBackground);
  },

  toggle(key): void {
    const next = !get()[key];
    set({ [key]: next } as Pick<GraphicsSettings, GraphicsKey>);
    persist(get());
    if (key === "liveBackground") markLiveBackground(next);
    const accountKey = ACCOUNT_KEYS[key];
    track("settings_changed", { setting: `graphics.${key}`, value: next, scope: accountKey === undefined ? "device" : "account" });
    if (accountKey !== undefined) void import("./account-settings").then(({ noteAccountSetting }) => noteAccountSetting(accountKey, next));
  },

  applyAccount(values): void {
    set(values);
    persist(get());
  },
}));

function persist(state: GraphicsSettings): void {
  value().write({
    telegraphs: state.telegraphs,
    weaponEffects: state.weaponEffects,
    damageNumbers: state.damageNumbers,
    liveBackground: state.liveBackground,
    art: state.art,
  });
}

/**
 * Метка на корне страницы: фон, блик и блеск гасит CSS (`tokens.css`,
 * `data-live-bg`), а не каждый компонент сам — так кнопка дизайн-системы не
 * знает о настройках игры.
 */
function markLiveBackground(on: boolean): void {
  if (typeof document === "undefined") return;
  if (on) document.documentElement.removeAttribute("data-live-bg");
  else document.documentElement.setAttribute("data-live-bg", "off");
}

/** Что передать движку на старте забега. */
export function runGraphics(): RunGraphicsOptions {
  const { telegraphs, weaponEffects, damageNumbers, art } = useGraphics.getState();
  // Без доступа арта нет при любой настройке: сохранённое «включён» — умолчание,
  // а не выбор игрока.
  return { telegraphs, weaponEffects, damageNumbers, art: draftArtAllowed() && art };
}

type StoredGraphics = z.infer<typeof schema>;

function value(): ReturnType<typeof createPersistedValue<StoredGraphics>> {
  return createPersistedValue<StoredGraphics>({
    storage: useShell.getState().storage,
    key: GRAPHICS_KEY,
    schema,
    fallback: DEFAULT_GRAPHICS,
    onBroken: (key, reason) => reportError("graphics", `${key}: ${reason}`),
  });
}
