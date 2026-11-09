/**
 * Правила игры, которые нужны серверу для проверки забега
 * (docs/34-stage3-plan.md, WP4).
 *
 * Это копия чисел из контента `core-game`, а не импорт: собранный бэкенд не
 * импортирует исходники пакетов монорепо — по той же причине отдельно живёт
 * словарь событий (docs/22-analytics-and-metrics.md §3.3). Разойтись с
 * контентом копия не может молча: `scripts/test/run-rules.test.ts` сверяет её
 * с `LOADOUT_LIMITS` и списком сложностей и падает, называя число.
 *
 * Это правила, а не пороги антифрода: сколько слотов под оружие, знает любой,
 * кто играл. Пороги — в конфигурации (`app-config.ts`, `RUNS_*`).
 */

/**
 * Единая сложность — `hard`, обучающий забег — `easy`; `normal` приходит
 * только от старых клиентов (Р126). Значения enum остаются прежними: сведение
 * в одно значение — отдельной задачей позже.
 */
export const DIFFICULTIES = ["easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * Сложности, забеги которых идут в рейтинг и сезоны (Р126). Остальные
 * принимаются, оцениваются антифродом и награждаются по прежним множителям,
 * но в доски не попадают. `scripts/test/run-rules.test.ts` следит, чтобы
 * каждая была в контенте.
 */
export const RATED_DIFFICULTIES = ["hard"] as const satisfies readonly Difficulty[];

export function isRatedDifficulty(difficulty: Difficulty): boolean {
  return (RATED_DIFFICULTIES as readonly Difficulty[]).includes(difficulty);
}

/** Сколько оружий может быть у игрока одновременно (`LOADOUT_LIMITS.weapons`). */
export const MAX_WEAPONS = 4;

/**
 * Сколько вторых шансов за забег (`CONTINUE.perRun`): сверх этого сервер
 * продолжение не продаёт.
 */
export const CONTINUES_PER_RUN = 1;

/**
 * Режимы забега (Р151, tasks/T-0279): копия `RUN_MODES` из `shared-types`, по
 * той же причине, что и остальное здесь. `prologue` — первый забег аккаунта:
 * сложность только `easy`, вне рейтинга и заданий (`prologue-rules.ts`).
 */
export const RUN_MODES = ["endless", "prologue"] as const;
export type RunMode = (typeof RUN_MODES)[number];
