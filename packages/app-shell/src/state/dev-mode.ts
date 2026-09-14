import { PASSIVES, WEAPONS, type RunDevCommand, type RunDevOptions } from "@bh/core-game";
import { create } from "zustand";
import { z } from "zod/mini";
import { effectiveAccess, usePlaytest } from "./playtest";
import { createPersistedValue } from "./persisted";
import { reportError, useShell } from "./shell";

/**
 * Режим разработчика забега (docs/26-stage2-plan.md, WP14): отображение,
 * время, читы и учёт в рейтинге. Настройки живут на устройстве и переживают
 * перезапуск — разработчик проверяет одно и то же десятки забегов подряд.
 *
 * Доступ решает сервер по `ADMIN_TELEGRAM_IDS`; «взведён» режим или нет —
 * выбор в разделе «Играть» на один заход и на устройстве не хранится.
 */
const DEV_KEY = "bh.dev.v1";

export const TIME_SCALES = [0.25, 0.5, 1, 2, 4] as const;
export const DAMAGE_MULS = [1, 2, 5, 10] as const;
export const MOVE_SPEED_MULS = [1, 1.5, 2, 3] as const;

const visualsSchema = z.object({
  hitboxes: z.boolean(),
  pickupRadius: z.boolean(),
  weaponRadii: z.boolean(),
  spawnRings: z.boolean(),
  bounds: z.boolean(),
  grid: z.boolean(),
  telegraphs: z.boolean(),
  damageNumbers: z.boolean(),
  effects: z.boolean(),
  techInfo: z.boolean(),
});

const cheatsSchema = z.object({
  godMode: z.boolean(),
  oneHitKill: z.boolean(),
  damageMul: z.number().check(z.positive(), z.maximum(100)),
  moveSpeedMul: z.number().check(z.positive(), z.maximum(10)),
  freezeEnemies: z.boolean(),
  spawnPaused: z.boolean(),
});

const settingsSchema = z.object({
  visuals: visualsSchema,
  cheats: cheatsSchema,
  timeScale: z.number().check(z.minimum(0.1), z.maximum(4)),
  /** просьба учесть забег с читами в рейтинге и рекорде — для проверки самого рейтинга */
  countInRating: z.boolean(),
  /** что сделать сразу на старте забега */
  start: z.object({
    allWeapons: z.boolean(),
    allPassives: z.boolean(),
    minute: z.int().check(z.minimum(0), z.maximum(60)),
  }),
});

export type DevSettings = z.infer<typeof settingsSchema>;
export type DevVisualKey = keyof DevSettings["visuals"];

export const DEFAULT_DEV_SETTINGS: DevSettings = {
  visuals: {
    hitboxes: false,
    pickupRadius: false,
    weaponRadii: false,
    spawnRings: false,
    bounds: false,
    grid: false,
    telegraphs: true,
    damageNumbers: true,
    effects: true,
    techInfo: true,
  },
  cheats: { godMode: false, oneHitKill: false, damageMul: 1, moveSpeedMul: 1, freezeEnemies: false, spawnPaused: false },
  timeScale: 1,
  countInRating: false,
  start: { allWeapons: false, allPassives: false, minute: 0 },
};

/**
 * Готовые наборы под частые проверки. Набор заменяет настройки целиком, а не
 * добавляет к ним: иначе после «Телеграфов» в «Чистом забеге» осталось бы
 * замедление времени, и замер FPS врал бы.
 */
export const DEV_PRESETS = {
  clean: DEFAULT_DEV_SETTINGS,
  telegraphs: {
    ...DEFAULT_DEV_SETTINGS,
    visuals: { ...DEFAULT_DEV_SETTINGS.visuals, hitboxes: true },
    cheats: { ...DEFAULT_DEV_SETTINGS.cheats, godMode: true },
    timeScale: 0.5,
  },
  arsenal: {
    ...DEFAULT_DEV_SETTINGS,
    visuals: { ...DEFAULT_DEV_SETTINGS.visuals, weaponRadii: true },
    cheats: { ...DEFAULT_DEV_SETTINGS.cheats, godMode: true },
    start: { allWeapons: true, allPassives: true, minute: 0 },
  },
  lateGame: {
    ...DEFAULT_DEV_SETTINGS,
    cheats: { ...DEFAULT_DEV_SETTINGS.cheats, godMode: true },
    start: { allWeapons: true, allPassives: true, minute: 10 },
  },
} satisfies Record<string, DevSettings>;

export type DevPresetId = keyof typeof DEV_PRESETS;

export interface DevModeStore {
  settings: DevSettings;
  /** следующий забег — забег разработчика */
  armed: boolean;
  hydrate(): void;
  arm(armed: boolean): void;
  update(patch: (settings: DevSettings) => DevSettings): void;
  applyPreset(id: DevPresetId): void;
}

export const useDevMode = create<DevModeStore>((set, get) => ({
  settings: DEFAULT_DEV_SETTINGS,
  armed: false,

  hydrate(): void {
    set({ settings: value().read() });
  },

  arm(armed): void {
    set({ armed });
  },

  update(patch): void {
    const next = patch(get().settings);
    set({ settings: next });
    value().write(next);
  },

  applyPreset(id): void {
    get().update(() => DEV_PRESETS[id]);
  },
}));

/** Открыт ли режим разработчика этому игроку в этой сборке. */
export function devModeAllowed(): boolean {
  const { capabilities } = useShell.getState();
  return effectiveAccess(usePlaytest.getState().access, capabilities.devTools === true).devMode;
}

export function toRunDev(settings: DevSettings): RunDevOptions {
  const start: RunDevCommand[] = [];
  // Уровень 99 движок сводит к последнему уровню каждого предмета.
  if (settings.start.allWeapons) for (const weapon of WEAPONS) start.push({ kind: "giveWeapon", id: weapon.id, level: 99 });
  if (settings.start.allPassives) for (const passive of PASSIVES) start.push({ kind: "givePassive", id: passive.id, level: 99 });
  if (settings.start.minute > 0) start.push({ kind: "jumpToMinute", minute: settings.start.minute });
  return { visuals: { ...settings.visuals }, cheats: { ...settings.cheats }, timeScale: settings.timeScale, start };
}

/** Включено ли что-то, что делает забег забегом с читами — для плашки на экранах. */
export function hasCheats(settings: DevSettings): boolean {
  const { cheats, start } = settings;
  return (
    cheats.godMode ||
    cheats.oneHitKill ||
    cheats.damageMul !== 1 ||
    cheats.moveSpeedMul !== 1 ||
    cheats.freezeEnemies ||
    cheats.spawnPaused ||
    settings.timeScale !== 1 ||
    start.allWeapons ||
    start.allPassives ||
    start.minute > 0
  );
}

function value(): ReturnType<typeof createPersistedValue<DevSettings>> {
  return createPersistedValue<DevSettings>({
    storage: useShell.getState().storage,
    key: DEV_KEY,
    schema: settingsSchema,
    fallback: DEFAULT_DEV_SETTINGS,
    onBroken: (key, reason) => reportError("dev-mode", `${key}: ${reason}`),
  });
}
