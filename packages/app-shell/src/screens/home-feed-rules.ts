import { formatDuration } from "../i18n";
import type { FeedItem } from "../state/feed-api";

/**
 * Правила ленты на главной (Р114, tasks/T-0176) — чистые функции без React:
 * как долго держится событие, что устарело, в каком порядке они сменяются и
 * какими словами говорятся. Время и случайность приходят параметрами.
 */

/** Событие старше суток не показывается и на устройстве, долго лежавшем с открытой главной. */
export const FEED_WINDOW_MS = 86_400_000;

/** Сколько держится одно событие: 5…8 секунд (Р114). */
export const FEED_HOLD_MIN_MS = 5_000;
export const FEED_HOLD_SPREAD_MS = 3_000;

/** Показов для аналитики за запуск: больше — шум, а не сигнал. */
export const FEED_VIEWS_PER_LAUNCH = 20;

export function freshItems(items: readonly FeedItem[], nowMs: number): FeedItem[] {
  return items.filter((item) => nowMs - item.atMs <= FEED_WINDOW_MS);
}

/** `random` — число из [0, 1): обе границы 5000 и 8000 достижимы. */
export function nextHoldMs(random: () => number): number {
  return FEED_HOLD_MIN_MS + Math.floor(random() * (FEED_HOLD_SPREAD_MS + 1));
}

/**
 * Следующее событие по кругу. Текущего нет в списке (лента обновилась, оно
 * устарело) — с начала; одно событие остаётся им же; пусто — `-1`.
 */
export function nextIndex(items: readonly Pick<FeedItem, "id">[], currentId: string | null): number {
  if (items.length === 0) return -1;
  const at = currentId === null ? -1 : items.findIndex((item) => item.id === currentId);
  return at === -1 ? 0 : (at + 1) % items.length;
}

const TEXT_KEYS: Record<FeedItem["kind"], string> = {
  long_run: "feed.longRun",
  week_record: "feed.weekRecord",
  boss: "feed.boss",
  chest: "feed.chest",
};

/** Ключ словаря и подстановки; формулировки нейтральны по роду — пола игрока не угадываем. */
export function feedTextOf(item: FeedItem): { key: string; params: Record<string, string | number> } {
  const seconds = item.seconds ?? 0;
  switch (item.kind) {
    case "long_run":
      return { key: TEXT_KEYS.long_run, params: { name: item.name, minutes: Math.floor(seconds / 60) } };
    case "week_record":
      return { key: TEXT_KEYS.week_record, params: { name: item.name, time: formatDuration(seconds) } };
    case "boss":
    case "chest":
      return { key: TEXT_KEYS[item.kind], params: { name: item.name } };
  }
}

/** Пора ли спрашивать ленту снова: прошло не меньше `refreshSec` с прошлого удачного ответа. */
export function feedDue(askedAt: number, refreshSec: number, nowMs: number): boolean {
  return askedAt === 0 || nowMs - askedAt >= refreshSec * 1000;
}

/**
 * Засчитать показ события в аналитику: раз на событие и не больше
 * `FEED_VIEWS_PER_LAUNCH` за запуск. Память — `Set` вызывающего модуля, не
 * хранилище: новый запуск начинает с нуля.
 */
export function claimFeedView(seen: Set<string>, id: string): boolean {
  if (seen.has(id) || seen.size >= FEED_VIEWS_PER_LAUNCH) return false;
  seen.add(id);
  return true;
}
