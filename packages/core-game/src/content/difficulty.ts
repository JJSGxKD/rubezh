import type { DifficultyDef, DifficultyId } from "@bh/shared-types";

// Уровни сложности — данные геймдизайнера. Множители ложатся поверх кривой
// сложности таймлайна: «Лёгкая» — баланс, откалиброванный ботом
// (content/balance-targets.ts), остальные строже по всем осям сразу.
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
    enemyHpMul: 1.8,
    enemyDamageMul: 1.5,
    spawnRateMul: 1.35,
    maxAliveMul: 1.3,
  },
];

/**
 * Что открыто по умолчанию. Не «Лёгкая»: на первом плейтесте игра на ней
 * ощущалась слишком простой, а первое впечатление складывается на том, что
 * выбрано за игрока.
 */
export const DEFAULT_DIFFICULTY_ID: DifficultyId = "normal";

export function findDifficulty(id: string): DifficultyDef | undefined {
  return DIFFICULTIES.find((difficulty) => difficulty.id === id);
}
