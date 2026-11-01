import type { DifficultyDef, DifficultyId } from "@bh/shared-types";

// Уровни сложности — данные геймдизайнера. Множители ложатся поверх кривой
// сложности таймлайна. Игроку выдаётся одна сложность — «Сложная» (Р126):
// она и есть главный бой, коридоры калибровки заданы для неё
// (content/balance-targets.ts). «Лёгкая» — только обучающий первый забег,
// «Нормальная» остаётся ради старых клиентов и записей.
//
// Порядок — от лёгкой к сложной: тест контента проверяет, что следующий
// уровень ни по одной оси не легче предыдущего.
export const DIFFICULTIES: DifficultyDef[] = [
  {
    id: "easy",
    nameKey: "difficulty.easy.name",
    descriptionKey: "difficulty.easy.description",
    enemyHpMul: 1,
    enemyDamageMul: 1,
    spawnRateMul: 1,
    maxAliveMul: 1,
  },
  {
    id: "normal",
    nameKey: "difficulty.normal.name",
    descriptionKey: "difficulty.normal.description",
    enemyHpMul: 1.3,
    enemyDamageMul: 1.2,
    spawnRateMul: 1.15,
    maxAliveMul: 1.1,
  },
  {
    id: "hard",
    nameKey: "difficulty.hard.name",
    descriptionKey: "difficulty.hard.description",
    enemyHpMul: 2,
    enemyDamageMul: 1.7,
    spawnRateMul: 1.5,
    maxAliveMul: 1.4,
  },
];

/**
 * Запасной уровень, когда id забега неизвестен: единая сложность, а не
 * «Нормальная» — другой в игре уже нет.
 */
export const DEFAULT_DIFFICULTY_ID: DifficultyId = "hard";

export function findDifficulty(id: string): DifficultyDef | undefined {
  return DIFFICULTIES.find((difficulty) => difficulty.id === id);
}
