import type { AccountUnlockDef, CardToolRules, CardToolUnlockDef } from "@bh/shared-types";

/**
 * Что открывает уровень аккаунта (docs/35-stage4-plan.md Р41, §3.13, О25).
 * Данные геймдизайнера: числа рабочие и крутятся здесь.
 *
 * Первый уровень — стартовый набор: три оружия, по два навыка в каждой
 * категории и урезанные слоты. Остальное растянуто лестницей до 14-го уровня
 * (Р102, docs/39-retention-mechanics.md К3): новое открытие приходит каждые
 * 1–3 уровня, иначе после пятнадцати забегов открывать нечего и цель
 * пропадает. Слоты чувствуются сильнее любого предмета, поэтому приходят на
 * 2-м и 3-м уровнях и доходят до потолка контента (`LOADOUT_LIMITS`). Уровни
 * 15–20 пусты нарочно: там встанет оружие поездов, у каждого своя строка.
 * Сила новичка растёт с каждым уровнем, а баланс забега одинаков для всех (Р40).
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
  { level: 3, passives: ["reach"], slots: { passives: { attack: 2 } } },
  { level: 4, weapons: ["storm"] },
  { level: 6, passives: ["ward"] },
  { level: 8, passives: ["volley"] },
  { level: 11, weapons: ["sting"] },
  { level: 14, passives: ["tempering"] },
  // Оружие поезда: уровни 15–20 отданы новому оружию (Р105).
  { level: 16, weapons: ["meteor"] },
];

/**
 * Заряды переброса, пропуска и изгнания карточек по уровню аккаунта
 * (docs/39-retention-mechanics.md Б3, docs/35-stage4-plan.md Р102). Значение
 * строки — итог с её уровня, как у слотов. Отдельный массив, а не поля
 * `ACCOUNT_UNLOCKS`: лестницу открытий правят отдельно, и обе таблицы не
 * должны конфликтовать. Числа стартовые, калибрует геймдизайнер. На уровнях
 * 1–2 зарядов нет: новичок видит три карточки, как раньше.
 */
export const CARD_TOOL_UNLOCKS: CardToolUnlockDef[] = [
  { level: 1, reroll: 0, skip: 0, banish: 0 },
  { level: 3, reroll: 1 },
  { level: 6, skip: 1 },
  { level: 9, reroll: 2, banish: 1 },
  { level: 14, skip: 2 },
  { level: 20, reroll: 3, banish: 2 },
];

/** Правила действий с карточками: пропуск платит долей пути до следующего уровня. */
export const CARD_TOOL_RULES: CardToolRules = { skipXpRatio: 0.3 };
