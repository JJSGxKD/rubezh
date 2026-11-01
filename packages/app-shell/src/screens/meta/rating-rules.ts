import { t } from "../../i18n";
import "../../i18n/season";
import type { LadderStep, PendingReward, SeasonReward } from "../../state/seasons-api";

/**
 * Чистые правила экрана недельного сезона (tasks/T-0111): время до конца,
 * даты, прогресс порога, лестница наград. Тексты — из словаря
 * `i18n/ru-season.json`, числа наград клиент не выдумывает: только множитель
 * сложности и то же округление, что у сервера.
 */

const HOUR_SEC = 3600;
const DAY_SEC = 86_400;
const MINUTE_SEC = 60;

/** Сколько осталось до конца сезона словами: «3 д 4 ч», «5 ч 20 мин», «12 мин». */
export function formatSeasonLeft(secondsLeft: number): string {
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) return t("season.closing");
  const whole = Math.floor(secondsLeft);
  if (whole >= DAY_SEC) {
    return t("season.left.day", { days: Math.floor(whole / DAY_SEC), hours: Math.floor((whole % DAY_SEC) / HOUR_SEC) });
  }
  if (whole >= HOUR_SEC) {
    return t("season.left.hour", { hours: Math.floor(whole / HOUR_SEC), minutes: Math.floor((whole % HOUR_SEC) / MINUTE_SEC) });
  }
  if (whole >= MINUTE_SEC) return t("season.left.min", { minutes: Math.floor(whole / MINUTE_SEC) });
  return t("season.left.lt1");
}

/**
 * Сколько осталось сейчас: ответ сервера минус время по монотонным часам
 * устройства (`performance.now()`), а не по часам телефона — у части они сбиты.
 * Часы, пошедшие назад (чужие данные в тесте), времени не прибавляют.
 */
export function seasonLeftAt(secondsLeft: number, receivedAtMs: number, nowMs: number): number {
  const elapsedSec = Math.max(0, nowMs - receivedAtMs) / 1000;
  return Math.max(0, secondsLeft - elapsedSec);
}

const DATE_PARTS = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });

interface DateLabel {
  day: string;
  month: string;
}

function dateLabel(iso: string): DateLabel | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = DATE_PARTS.formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return day === undefined || month === undefined ? null : { day, month };
}

/**
 * Даты сезона по Гринвичу: «2–8 ноября», на стыке месяцев — «28 декабря –
 * 3 января». Конец сезона — понедельник 00:00, последний день — сутками раньше.
 * Часовой пояс устройства не участвует: всё через UTC.
 */
export function seasonRangeLabel(startsAt: string, endsAt: string): string {
  const end = new Date(endsAt);
  const first = dateLabel(startsAt);
  const last = Number.isNaN(end.getTime()) ? null : dateLabel(new Date(end.getTime() - DAY_SEC * 1000).toISOString());
  if (first === null || last === null) return "";
  if (first.month === last.month) return `${first.day}–${last.day} ${last.month}`;
  return `${first.day} ${first.month} – ${last.day} ${last.month}`;
}

/** Одна дата по Гринвичу — «2 ноября»: когда начнётся первый сезон. */
export function seasonDateLabel(iso: string): string {
  const label = dateLabel(iso);
  return label === null ? "" : `${label.day} ${label.month}`;
}

/** Порог недели: достигнут ли и сколько секунд осталось продержаться. */
export function thresholdProgress(best: number | null, threshold: number): { reached: boolean; leftSec: number } {
  if (best === null) return { reached: false, leftSec: threshold };
  return best >= threshold ? { reached: true, leftSec: 0 } : { reached: false, leftSec: threshold - best };
}

export interface LadderRow {
  /** «1 место», «2–3 места» */
  label: string;
  coins: number;
  prestige: number;
}

/** Ступени мест с множителем сложности; округление — `Math.round`, как у сервера. */
export function ladderRows(ladder: readonly LadderStep[], mul: number): LadderRow[] {
  return ladder.map((step) => ({
    label:
      step.fromPlace === step.toPlace
        ? t("season.place.single", { n: step.fromPlace })
        : t("season.place.range", { from: step.fromPlace, to: step.toPlace }),
    coins: Math.round(step.coins * mul),
    prestige: Math.round(step.prestige * mul),
  }));
}

/** Сумма наград, которые ждут в плашке «Забрать». */
export function pendingTotal(pending: readonly PendingReward[]): SeasonReward {
  return pending.reduce<SeasonReward>(
    (sum, entry) => ({ coins: sum.coins + entry.coins, prestige: sum.prestige + entry.prestige }),
    { coins: 0, prestige: 0 },
  );
}

