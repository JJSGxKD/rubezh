import type { RecordedRun } from "../runs/runs-hooks.js";
import type { FeedEvent } from "./feed-events.js";

/**
 * Правила ленты без Nest и Redis (tasks/T-0174): что из забега становится
 * событием и что из набора событий видит игрок.
 */

/** Лента показывает последние сутки (Р114). */
export const FEED_WINDOW_MS = 86_400_000;

/**
 * «Настоящий» забег: рейтинговый, с вердиктом `ok` и без читов. Тот же фильтр,
 * что пускает забег в рейтинг, поэтому сомнительные и отклонённые в ленту не
 * попадают и не двигают лидера недели.
 */
export function isFeedRun(run: RecordedRun): boolean {
  return run.ranked && run.verdict === "ok" && !run.cheats;
}

/**
 * События забега. Рекорд недели решает вызывающий: для этого нужна таблица
 * недели, а здесь её нет.
 */
export function feedEventsOf(run: RecordedRun, rules: { longRunSec: number }, weekRecord: boolean): FeedEvent[] {
  if (!isFeedRun(run)) return [];
  const atMs = run.finishedAt.getTime();
  const events: FeedEvent[] = [];
  if (run.survivalSec >= rules.longRunSec) events.push({ id: `${run.runId}:long_run`, kind: "long_run", accountId: run.accountId, atMs, seconds: run.survivalSec });
  if (weekRecord) events.push({ id: `${run.runId}:week_record`, kind: "week_record", accountId: run.accountId, atMs, seconds: run.survivalSec });
  return events;
}

export interface VisibleOptions {
  nowMs: number;
  /** аккаунты, которых рейтинг скрывает: закрытый рейтинг, отдельная доска, блокировка */
  hidden: ReadonlySet<string>;
  /** не больше стольких событий одного игрока: иначе лента — витрина одного человека */
  perPlayer: number;
  limit: number;
}

/**
 * Что отдавать: не старше суток, без скрытых игроков, у каждого — самые
 * свежие `perPlayer`, от свежих к старым, не больше `limit`.
 */
export function visibleEvents(events: readonly FeedEvent[], options: VisibleOptions): FeedEvent[] {
  const since = options.nowMs - FEED_WINDOW_MS;
  const fresh = events.filter((event) => event.atMs >= since && !options.hidden.has(event.accountId)).sort((a, b) => b.atMs - a.atMs);
  const taken = new Map<string, number>();
  const result: FeedEvent[] = [];
  for (const event of fresh) {
    const count = taken.get(event.accountId) ?? 0;
    if (count >= options.perPlayer) continue;
    taken.set(event.accountId, count + 1);
    result.push(event);
    if (result.length >= options.limit) break;
  }
  return result;
}
