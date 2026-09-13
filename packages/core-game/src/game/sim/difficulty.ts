import { DIFFICULTY_IDS, type DifficultyDef } from "@bh/shared-types";

/**
 * Уровень сложности без поправок — симуляция по умолчанию. Тесты и стенд
 * испытаний идут на нём: сложность — свойство забега игрока, а не движка.
 */
export const BASE_DIFFICULTY: DifficultyDef = {
  id: "easy",
  nameKey: "difficulty.easy.name",
  descriptionKey: "difficulty.easy.description",
  enemyHpMul: 1,
  enemyDamageMul: 1,
  spawnRateMul: 1,
  maxAliveMul: 1,
};

const MULTIPLIERS = ["enemyHpMul", "enemyDamageMul", "spawnRateMul", "maxAliveMul"] as const;

/** Проблемы в одном уровне сложности: множитель ноль или меньше ломает забег молча. */
export function findDifficultyProblems(def: DifficultyDef): string[] {
  const problems: string[] = [];
  if (!DIFFICULTY_IDS.includes(def.id)) {
    problems.push(`сложность ${String(def.id)}: id не из ${DIFFICULTY_IDS.join(", ")}`);
  }
  for (const key of MULTIPLIERS) {
    const value = def[key];
    if (!Number.isFinite(value) || value <= 0) {
      problems.push(`сложность ${def.id}: ${key} должен быть больше нуля`);
    }
  }
  return problems;
}

/**
 * Проверка всего списка: каждый уровень корректен, id не повторяются, и
 * следующий уровень ни по одной оси не легче предыдущего — иначе «Сложная»
 * где-то проще «Нормальной», и игрок выбирает не то, что написано.
 */
export function findDifficultyContentProblems(defs: readonly DifficultyDef[]): string[] {
  const problems = defs.flatMap(findDifficultyProblems);
  const seen = new Set<string>();

  defs.forEach((def, index) => {
    if (seen.has(def.id)) problems.push(`сложность ${def.id}: id повторяется`);
    seen.add(def.id);

    const previous = defs[index - 1];
    if (previous === undefined) return;
    for (const key of MULTIPLIERS) {
      if (def[key] < previous[key]) {
        problems.push(`сложность ${def.id}: ${key} меньше, чем у ${previous.id}`);
      }
    }
  });
  return problems;
}
