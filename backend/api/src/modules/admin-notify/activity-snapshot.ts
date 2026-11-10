import { dayWindow, previousDay, teamDay } from "./daily-stats.js";

/**
 * Суточные снимки аудитории (tasks/T-0203): какие сутки пора закрыть, окна
 * DAU/WAU/MAU и рекорд. Только арифметика суток по Москве — без базы, Redis и
 * часов, чтобы проверять её тестом без окружения. Первая реализация витрины
 * `mart_dau` без разрезов (docs/22-analytics-and-metrics.md, §4).
 */

/** Сколько суток один проход закрывает с нуля: дальше историю доберёт следующий проход. */
export const SNAPSHOT_BACKFILL_LIMIT = 400;
/** Ночное задание: в 00:20 по Москве, после отчёта в 00:10 (`REPORT_AT_MIN`). */
export const SNAPSHOT_CRON = "20 0 * * *";
export const SNAPSHOT_TIME_ZONE = "Europe/Moscow";

const DAY_MS = 86_400_000;

/** Длина окна активности, сутки: DAU, WAU и MAU. */
export type WindowLength = 1 | 7 | 30;

/** Полуоткрытое окно `[from, to)`. */
export interface ActivityWindow {
  from: Date;
  to: Date;
}

/** Следующие сутки календарём. Москва живёт без перехода на летнее время, поэтому сутки — ровно 24 часа. */
export function nextDay(day: string): string {
  return teamDay(dayWindow(day).to.getTime());
}

/**
 * Сутки, которые пора закрыть: от следующих за последней записью (или от суток
 * первой сессии, если таблица пуста) до вчерашних включительно, не больше
 * `limit` по порядку. Сегодняшние сутки не закрываются: они ещё идут. Нет ни
 * записей, ни сессий — закрывать нечего.
 */
export function daysToClose(lastClosed: string | null, firstSession: Date | null, now: Date, limit: number = SNAPSHOT_BACKFILL_LIMIT): string[] {
  const start = lastClosed !== null ? nextDay(lastClosed) : firstSession !== null ? teamDay(firstSession.getTime()) : null;
  if (start === null) return [];
  const yesterday = previousDay(teamDay(now.getTime()));
  const days: string[] = [];
  // Сутки — строки `ГГГГ-ММ-ДД`: порядок строк совпадает с порядком календаря.
  for (let day = start; day <= yesterday && days.length < limit; day = nextDay(day)) days.push(day);
  return days;
}

/**
 * Окно в `length` суток, заканчивающееся этими сутками включительно:
 * `[полночь (day − length + 1), полночь (day + 1))`.
 */
export function windowOf(day: string, length: WindowLength): ActivityWindow {
  const { from, to } = dayWindow(day);
  return { from: new Date(from.getTime() - (length - 1) * DAY_MS), to };
}

/** Лучшие сутки: максимум, а при равенстве — более ранние. Пусто — рекорда нет. */
export function pickRecord(points: readonly { day: string; value: number }[]): { value: number; day: string } | null {
  let best: { value: number; day: string } | null = null;
  for (const point of points) {
    if (best === null || point.value > best.value || (point.value === best.value && point.day < best.day)) best = { value: point.value, day: point.day };
  }
  return best;
}
