import type { RunModifierDef } from "@bh/shared-types";

// Модификаторы забега — данные геймдизайнера (docs/39-retention-mechanics.md Б8, Р105).
// Игрок берёт условие на себя перед забегом и получает за него награду. Оси ложатся
// умножением поверх выбранной сложности (`composeDifficulty`), поэтому «Спешка» на
// «Сложной» — это 1,5 × 1,5 по темпу спавна, а не 1,5. Числа стартовые, калибрует
// геймдизайнер; коридор медианы бота — `MODIFIER_TARGETS` в `balance-targets.ts`.
//
// Множитель награды за забег здесь не лежит: его читает сервер, и он живёт рядом с
// id в `shared-types` (`RUN_MODIFIER_REWARD_MUL`). Открытие уровнем аккаунта —
// `unlocks.ts`.
//
// Правила списка проверяет `findModifierProblems`: все оси конечны и больше нуля,
// модификатор чем-то отличается от «без модификатора», здоровье · темп спавна не
// меньше единицы (иначе орда слабее базы, а награда за неё выше), опыт в бою не
// меньше единицы.
export const RUN_MODIFIERS: RunModifierDef[] = [
  // Больше врагов и быстрее уровни: враги чуть злее, общая масса орды выше базы.
  {
    id: "hurry",
    nameKey: "modifier.hurry.name",
    descriptionKey: "modifier.hurry.description",
    enemyHpMul: 1,
    enemyDamageMul: 1.1,
    spawnRateMul: 1.5,
    maxAliveMul: 1.25,
    xpMul: 1.5,
  },
  // Орда наоборот: врагов мало, но они крепкие и бьют больно. Общий запас здоровья
  // орды выше базы (2 × 0,6 = 1,2), поэтому награда за неё не меньше.
  {
    id: "inverse",
    nameKey: "modifier.inverse.name",
    descriptionKey: "modifier.inverse.description",
    enemyHpMul: 2,
    enemyDamageMul: 1.3,
    spawnRateMul: 0.6,
    maxAliveMul: 0.7,
    xpMul: 1.6,
  },
];

/**
 * Сколько модификаторов можно взять на один забег. «Спешка» и «Инверсия» тянут
 * нагрузку в разные стороны, вместе они бессмысленны. В данных забега это массив из
 * нуля или одного id: потолок поднимается без смены формата.
 */
export const MAX_MODIFIERS_PER_RUN = 1;

export function findRunModifier(id: string): RunModifierDef | undefined {
  return RUN_MODIFIERS.find((modifier) => modifier.id === id);
}
