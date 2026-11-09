import type { DifficultyId } from "@bh/shared-types";

/**
 * Сложность игрока (docs/35-stage4-plan.md, Р126): выбора нет, она одна.
 * Единая сложность занимает место `"hard"`, а легче только первый, обучающий
 * забег аккаунта — это прежняя `"easy"`. Внутренние id остаются: сведение их в
 * одно значение — отдельная задача после перехода. `"normal"` новый клиент не
 * выдаёт, но читает: сохранённый забег и очередь отправки прежних сборок.
 */
export const RATED_DIFFICULTY_ID = "hard" satisfies DifficultyId;
export const TUTORIAL_DIFFICULTY_ID = "easy" satisfies DifficultyId;

/**
 * Сложность следующего забега по числу законченных забегов аккаунта. Битое
 * число (отрицательное, `NaN`) считается нулём: хуже показать новичку
 * обучение, чем бывалому — полную сложность без подготовки.
 */
export function difficultyForNextRun(runsPlayed: number): DifficultyId {
  return runsPlayed > 0 ? RATED_DIFFICULTY_ID : TUTORIAL_DIFFICULTY_ID;
}

/**
 * Ключ плашки сложности в истории забегов; `null` — плашки нет. Её получают
 * только забеги не на единой сложности: «Обучение» и прежняя «Нормальная».
 */
export function historyDifficultyKey(id: DifficultyId): string | null {
  if (id === RATED_DIFFICULTY_ID) return null;
  return `difficulty.${id}.name`;
}
