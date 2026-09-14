import { DEFAULT_DEV_SETTINGS, type DevSettings } from "../../state/dev-mode";

/**
 * Наборы и шкалы листа разработчика. Живут рядом с листом, а не в сторе: лист
 * приходит отдельным чанком, и первая загрузка игрока их не несёт.
 */

export const TIME_SCALES = [0.25, 0.5, 1, 2, 4] as const;
export const DAMAGE_MULS = [1, 2, 5, 10] as const;
export const MOVE_SPEED_MULS = [1, 1.5, 2, 3] as const;

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
    autoPickUpgrades: true,
    start: { allWeapons: true, allPassives: true, minute: 0 },
  },
  lateGame: {
    ...DEFAULT_DEV_SETTINGS,
    cheats: { ...DEFAULT_DEV_SETTINGS.cheats, godMode: true },
    autoPickUpgrades: true,
    start: { allWeapons: true, allPassives: true, minute: 10 },
  },
} satisfies Record<string, DevSettings>;

export type DevPresetId = keyof typeof DEV_PRESETS;
