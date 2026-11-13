import { isRatedRun } from "./rated-runs.js";
import type { Difficulty } from "./run-rules.js";

/**
 * Решения разбора забега (Р203, tasks/T-0419): чистые правила без Nest и
 * Prisma — их читают сервис, репозиторий и тесты.
 *
 * Состояние забега — колонка `review_outcome`: `null` (не разбирался),
 * `honest` (команда признала забег честным) или `annulled` (убран из досок
 * рейтинга и сезона). Три действия ведут между состояниями по таблице
 * `TRANSITIONS`; повтор того же исхода — не ошибка, а тот же ответ.
 */

export const REVIEW_OUTCOMES = ["honest", "annulled"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
export type ReviewAction = "honest" | "annul" | "restore";

/** Строка колонки → исход; незнакомое значение — `null` (как «не разбирался»), а не исключение. */
export function reviewOutcomeOf(value: string | null): ReviewOutcome | null {
  return REVIEW_OUTCOMES.find((outcome) => outcome === value) ?? null;
}

/**
 * Куда ведёт действие и из каких состояний оно разрешено. «Вернуть забег»
 * ставит `honest`, а не `null`: команда решила, что забег годен, и
 * подозрительный забег не должен вернуться в очередь.
 */
export const TRANSITIONS: Record<ReviewAction, { to: ReviewOutcome; from: readonly (ReviewOutcome | null)[] }> = {
  honest: { to: "honest", from: [null] },
  annul: { to: "annulled", from: [null, "honest"] },
  restore: { to: "honest", from: ["annulled"] },
};

/** Вердикты, которые попадают в очередь разбора. */
const QUEUE_VERDICTS: readonly string[] = ["suspicious", "rejected"];

/** Подозрительный или отклонённый — то, что проверка ставит в очередь. */
export function inQueue(verdict: string | null): boolean {
  return verdict !== null && QUEUE_VERDICTS.includes(verdict);
}

interface Reviewable {
  verdict: string | null;
  reviewOutcome: ReviewOutcome | null;
}

/** Что делать с действием по нынешнему состоянию строки. */
export type ReviewDecision = "apply" | "same" | "not_in_review" | "already_annulled" | "not_annulled";

export function decide(action: ReviewAction, run: Reviewable): ReviewDecision {
  const { to, from } = TRANSITIONS[action];
  if (from.includes(run.reviewOutcome)) {
    // «Честный» признаёт то, в чём проверка сомневалась: забегу, не попавшему в очередь, признавать нечего.
    return action === "honest" && !inQueue(run.verdict) ? "not_in_review" : "apply";
  }
  if (run.reviewOutcome === to) return "same";
  // Остальное — состояние, из которого действие недоступно: у `annul` таких нет, он разрешён из любого, кроме своего исхода.
  return action === "restore" ? "not_annulled" : "already_annulled";
}

/** Какие действия разрешает состояние забега; права панель проверяет сама. */
export function availableActions(run: Reviewable): { honest: boolean; annul: boolean; restore: boolean } {
  return {
    honest: run.reviewOutcome === null && inQueue(run.verdict),
    annul: run.reviewOutcome !== "annulled",
    restore: run.reviewOutcome === "annulled",
  };
}

/**
 * Вернут ли «Честный» и «Вернуть забег» забег в рейтинг — то же правило, что
 * условие `UNRANKED_BY_MODERATOR` в запросе (`runs.repository.ts`): законченный
 * забег рейтинговой сложности не раньше отсечки, без читов, сданный без
 * ограничения рейтинга и не пролог. Вердикт не важен: решение команды сильнее
 * вердикта проверки.
 */
export function returnableToRating(
  run: { difficulty: Difficulty; finishedAt: Date; cheats: boolean; ratingRestricted: string | null; mode: string },
  since: Date | null,
): boolean {
  return isRatedRun(run.difficulty, run.finishedAt, since) && !run.cheats && run.ratingRestricted === null && run.mode !== "prologue";
}
