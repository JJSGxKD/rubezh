import { ratingSinceOf } from "../runs/rated-runs.js";
import { parseStartDate } from "../seasons/season-rules.js";

/**
 * Переход рейтинга со времени на очки эффективности (tasks/T-0294, Р66, Р152).
 * Чистые функции без Nest, Redis и базы: настройка приходит числом, время —
 * параметром.
 *
 * Правило одно: **сезон считается по очкам, если он начался не раньше
 * `rating.points-from`**. Сезон, идущий в момент выката, дотягивается по
 * времени — менять правила посреди недели нечестно к тем, кто уже играл. Архив
 * закрытых сезонов не пересчитывается: их итоги лежат как были.
 *
 * Общая доска всех времён в этом правиле не участвует: она переходит сразу, а
 * какие числа в ней лежат, знает хранилище (`LeaderboardStore.scoring`).
 */

/** Чем ранжируется доска: очками лучшего забега или его временем. */
export type Scoring = "points" | "time";

/**
 * Значение `rating.points-from` (ГГГГММДД) в понедельник начала первого сезона
 * по очкам. `0`, не дата и не понедельник — `null`: сезонов по очкам нет, все
 * идут по времени.
 */
export function pointsFromOf(value: number): Date | null {
  // Дата — календарная и без права на год короче четырёх знаков (общее правило отсечки), понедельник — как у старта сезонов.
  if (ratingSinceOf(value) === null) return null;
  return parseStartDate(value);
}

/** Как считается сезон, начавшийся в `startsAt`. */
export function scoringOfSeason(startsAt: Date, pointsFrom: Date | null): Scoring {
  return pointsFrom !== null && startsAt.getTime() >= pointsFrom.getTime() ? "points" : "time";
}

/**
 * Идентификатор доски сезона в Redis. Сезон по времени живёт под прежним
 * ключом, по очкам — под ключом с приставкой `pts:`: два режима не делят одно
 * множество, и переключение идёт без окна, где доска пуста.
 */
export function boardKeyOf(seasonKey: string, scoring: Scoring): string {
  return scoring === "points" ? `${POINTS_PREFIX}${seasonKey}` : seasonKey;
}

/** Приставка ключей Redis досок по очкам. */
export const POINTS_PREFIX = "pts:";

/**
 * Число, по которому ранжируется забег на этой доске; `null` — забег на ней не
 * стоит: очков нет (пролог, сбой подсчёта, забег до очков и не пересчитанный).
 */
export function scoreOf(run: { survivalSec: number; points?: number | null | undefined }, scoring: Scoring): number | null {
  if (scoring === "time") return run.survivalSec;
  return run.points ?? null;
}

/** Порог награды участника сезона: очки в сезоне по очкам, секунды в сезоне по времени. */
export function thresholdOf(scoring: Scoring, seconds: number, points: number): number {
  return scoring === "points" ? points : seconds;
}
