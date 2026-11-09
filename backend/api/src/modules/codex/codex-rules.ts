import type { RecordedRun } from "../runs/runs-hooks.js";

/**
 * Кодекс врагов (docs/39-retention-mechanics.md К2, tasks/T-0127): правила без
 * Nest и базы. Враг открывается, когда игрок встретил его в забеге, и не
 * закрывается обратно; награда за кодекс — три достижения лестницы `codex`
 * (категория «Коллекция»), а не отдельная система.
 */

/**
 * Враги кодекса — все враги контента движка, включая элиту, боссов и потомков
 * делящихся. Бэкенд `core-game` не импортирует, поэтому список — таблица, а
 * её равенство `content/enemies.ts` держит тест: новый враг в контенте роняет
 * его, пока id не добавили сюда.
 */
export const CODEX_ENEMY_IDS: readonly string[] = [
  "swarm_rat",
  "tank_ghoul",
  "bone_walker",
  "mire_shambler",
  "cordon_guard",
  "dasher_wolf",
  "circler_crow",
  "bomber_imp",
  "rushing_bats",
  "splitter_slime",
  "elite_ghoul",
  "elite_grave_knight",
  "boss_matryoshka",
  "boss_ram",
  "rubezh_guard",
];

/** Достижение за полный кодекс: его строку клиент показывает у полосы. */
export const CODEX_REWARD_TASK_ID = "ach_codex_100";

/**
 * Какая доля кодекса открыта, целым процентом вниз. Пустой список — ноль;
 * открытых больше, чем всего (список врагов сократили), — не выше ста.
 */
export function percentOf(opened: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((opened * 100) / total));
}

/**
 * Какие записи забег открывает впервые: враги из таблицы, ещё не открытые,
 * без повторов и в порядке таблицы. Чужие id отбрасываются — итог забега
 * приходит со слов клиента.
 */
export function newEntries(run: Pick<RecordedRun, "enemiesSeen">, known: ReadonlySet<string>): string[] {
  const seen = new Set(run.enemiesSeen ?? []);
  return CODEX_ENEMY_IDS.filter((id) => seen.has(id) && !known.has(id));
}
