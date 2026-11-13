import { DIFFICULTY_IDS, RUN_MODIFIER_IDS, type DifficultyDef, type RunModifierDef, type RunModifierId } from "@bh/shared-types";

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
  if (def.xpMul !== undefined && (!Number.isFinite(def.xpMul) || def.xpMul <= 0)) {
    problems.push(`сложность ${def.id}: xpMul должен быть больше нуля`);
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

// --- Модификаторы забега (T-0119) ---------------------------------------------------

const MODIFIER_MULTIPLIERS = ["enemyHpMul", "enemyDamageMul", "spawnRateMul", "maxAliveMul", "xpMul"] as const;

/**
 * Сложность забега с модификаторами: оси базовой умножаются на оси модификатора,
 * `id` остаётся базовым — рекорд и лидерборд ведутся по сложности, а не по её
 * сочетанию. Без модификатора возвращается копия базы без `xpMul`: забег без поля
 * считается так же, как до модификаторов, побитово. Незнакомый id пропускается —
 * решает ли он что-то для игрока, определяет `resolveModifierIds`.
 *
 * Только умножение и фиксированный порядок: степеней и округлений здесь нет,
 * результат одинаков на любом JS-движке.
 */
export function composeDifficulty(base: DifficultyDef, modifierIds: readonly string[], modifiers: readonly RunModifierDef[]): DifficultyDef {
  const composed: DifficultyDef = { ...base };
  for (const id of modifierIds) {
    const modifier = modifiers.find((candidate) => candidate.id === id);
    if (modifier === undefined) continue;
    composed.enemyHpMul *= modifier.enemyHpMul;
    composed.enemyDamageMul *= modifier.enemyDamageMul;
    composed.spawnRateMul *= modifier.spawnRateMul;
    composed.maxAliveMul *= modifier.maxAliveMul;
    composed.xpMul = (composed.xpMul ?? 1) * modifier.xpMul;
  }
  return composed;
}

/**
 * Модификаторы, которые реально попадут в мир забега: известные, без повторов, не
 * больше `max` и только открытые уровнем аккаунта (`open`; `null` — уровня нет, открыто
 * всё, как у оружия). Порядок — как в запросе. Остальное молча отбрасывается: сервер
 * проверяет заявку игрока сам (T-0122), а движок не должен падать на устаревшей записи.
 */
export function resolveModifierIds(
  requested: readonly string[] | undefined,
  modifiers: readonly RunModifierDef[],
  max: number,
  open: ReadonlySet<string> | null,
): RunModifierId[] {
  const result: RunModifierId[] = [];
  for (const id of requested ?? []) {
    if (result.length >= max) break;
    const modifier = modifiers.find((candidate) => candidate.id === id);
    if (modifier === undefined || result.includes(modifier.id)) continue;
    if (open !== null && !open.has(modifier.id)) continue;
    result.push(modifier.id);
  }
  return result;
}

/**
 * Проверка списка модификаторов человеческим языком: запись названа, число названо.
 * Здоровье · темп спавна не меньше единицы — иначе общий запас здоровья орды ниже
 * базы, и награда за «трудный» режим достаётся за более лёгкий бой.
 */
export function findModifierProblems(defs: readonly RunModifierDef[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const def of defs) {
    const name = `модификатор ${String(def.id)}`;
    if (!RUN_MODIFIER_IDS.includes(def.id)) problems.push(`${name}: id не из ${RUN_MODIFIER_IDS.join(", ")}`);
    if (seen.has(def.id)) problems.push(`${name}: id повторяется`);
    seen.add(def.id);

    let valid = true;
    for (const key of MODIFIER_MULTIPLIERS) {
      const value = def[key];
      if (!Number.isFinite(value) || value <= 0) {
        problems.push(`${name}: ${key} должен быть больше нуля`);
        valid = false;
      }
    }
    for (const key of ["nameKey", "descriptionKey"] as const) {
      if (def[key].trim() === "") problems.push(`${name}: ${key} пуст`);
    }
    if (!valid) continue;

    if (MODIFIER_MULTIPLIERS.every((key) => def[key] === 1)) problems.push(`${name}: ничем не отличается от забега без модификатора`);
    if (def.enemyHpMul * def.spawnRateMul < 1) problems.push(`${name}: здоровье · темп спавна меньше 1 — орда слабее базы`);
    if (def.xpMul < 1) problems.push(`${name}: xpMul должен быть не меньше 1`);
  }
  return problems;
}
