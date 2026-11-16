/**
 * Серия дней (docs/35-stage4-plan.md Р154, tasks/T-0262): каждый день подряд
 * добавляет +5 % к награде дня, до +50 % на десятый день. Пропущенный день
 * серию не обнуляет (Р45), а снимает две ступени за каждые сутки пропуска.
 *
 * Сутки — игровые (`common/game-day.ts`): их границу считает база и отдаёт
 * днями `ГГГГ-ММ-ДД`, поэтому здесь разница считается по календарю, а не по
 * часам. Числа — константы рядом с формулой награды дня, настройки у них нет.
 */

/** прибавка к награде дня за ступень серии */
export const STREAK_STEP = 0.05;
/** потолок ступеней: десятый день подряд даёт +50 % */
export const STREAK_MAX = 10;
/** сколько ступеней снимает каждый пропущенный день */
export const STREAK_MISS_PENALTY = 2;

const DAY_MS = 86_400_000;

/** Что видит игрок: ступень, прибавка в процентах и ступень после следующего забора. */
export interface StreakView {
  days: number;
  bonusPercent: number;
  next: number;
}

function clampStreak(streak: number): number {
  return Math.min(STREAK_MAX, Math.max(0, Math.floor(streak)));
}

function dayIndex(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Math.round(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1) / DAY_MS);
}

/** Целые сутки пропуска между последним забором и сегодняшним днём: вчера — 0, позавчера — 1. */
function missedDays(lastClaimDay: string, today: string): number {
  return dayIndex(today) - dayIndex(lastClaimDay) - 1;
}

/**
 * Множитель награды дня. Считается целыми процентами, а не `1 + 0,05 × n`:
 * иначе 0,15 и 1,15 попали бы в округление награды с хвостом двоичной дроби.
 */
export function streakMul(streak: number): number {
  return (100 + clampStreak(streak) * Math.round(STREAK_STEP * 100)) / 100;
}

/**
 * Ступень серии, которую даст забор в сутки `today`. Забор вчера — на одну
 * выше; пропуск `d` суток — `max(0, ступень − 2·d) + 1`; потолок — десять.
 * Повтор в те же сутки ступень не меняет.
 */
export function nextStreak(streak: number, lastClaimDay: string | null, today: string): number {
  const current = clampStreak(streak);
  if (lastClaimDay === null) return 1;
  const missed = missedDays(lastClaimDay, today);
  if (missed < 0) return current;
  return Math.min(STREAK_MAX, Math.max(0, current - STREAK_MISS_PENALTY * missed) + 1);
}

/** Ступень серии на сегодня до забора: пропущенные сутки уже сняли свои ступени, забор ещё не добавил. */
export function currentStreak(streak: number, lastClaimDay: string | null, today: string): number {
  const current = clampStreak(streak);
  if (lastClaimDay === null) return 0;
  const missed = missedDays(lastClaimDay, today);
  return missed <= 0 ? current : Math.max(0, current - STREAK_MISS_PENALTY * missed);
}

/**
 * Серия для ответа награды дня. Забрано сегодня — `days` это ступень забора, а
 * `next` — после завтрашнего. Не забрано — `days` уже со снятыми за пропуск
 * ступенями, а `next` — что даст сегодняшний забор.
 */
export function streakView(streak: number, lastClaimDay: string | null, today: string, claimedToday: boolean): StreakView {
  const days = claimedToday ? clampStreak(streak) : currentStreak(streak, lastClaimDay, today);
  const next = claimedToday ? Math.min(STREAK_MAX, days + 1) : nextStreak(streak, lastClaimDay, today);
  return { days, bonusPercent: Math.round(days * STREAK_STEP * 100), next };
}
