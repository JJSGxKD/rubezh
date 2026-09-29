import type { AccountUnlockDef } from "@bh/shared-types";

/**
 * Что открывает уровень аккаунта (docs/35-stage4-plan.md Р41, §3.13, О25).
 * Данные геймдизайнера: числа рабочие и крутятся здесь.
 *
 * Первый уровень — стартовый набор: три оружия, по два навыка в каждой
 * категории и урезанные слоты. Остальное открывается за первые уровни, то
 * есть за первые забеги (кривая опыта — Р36): к шестому уровню открыто всё, а
 * слоты доходят до потолка контента (`LOADOUT_LIMITS`). Сила новичка растёт
 * с каждым уровнем, а баланс забега одинаков для всех (Р40).
 *
 * Правила таблицы проверяет тест контента: каждое оружие и навык открываются
 * ровно на одном уровне, слоты не убывают и приходят к потолку, в каждой
 * категории открытых навыков больше, чем слотов под неё, — иначе выбирать
 * нечего.
 */
export const ACCOUNT_UNLOCKS: AccountUnlockDef[] = [
  {
    level: 1,
    weapons: ["spark", "knife", "wardstone"],
    passives: ["might", "haste", "vitality", "mending", "swiftness", "lodestone"],
    slots: { weapons: 2, passives: { attack: 1, defense: 1, mobility: 1 } },
  },
  // Третье оружие — первое, что дают уровни: слот чувствуется в первом же
  // забеге сильнее любой пассивки.
  { level: 2, weapons: ["hearth"], slots: { weapons: 3 } },
  { level: 3, passives: ["reach", "ward"], slots: { passives: { attack: 2 } } },
  { level: 4, weapons: ["storm"], passives: ["volley"] },
  { level: 5, passives: ["tempering"] },
  { level: 6, weapons: ["sting"] },
];
