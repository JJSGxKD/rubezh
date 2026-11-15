import { periodOf } from "@bh/ledger";

/**
 * Правила месяца учёта (docs/37-accounting.md §13, Р222, tasks/T-0468): статусы, границы по UTC, ключи проводок
 * закрытия. Чистые функции без Nest и Prisma — месяц нужен и сервису, и репозиторию, и тестам.
 *
 * Месяц — строка «ГГГГ-ММ» по UTC: строки одной ширины сравниваются как обычный текст, и «раньше или позже» не
 * требует разбора дат (так же устроены доли участников, `stakeholders/stakeholder-rules.ts`).
 */

/** Открыт — строки у месяца может не быть вовсе; на сверке — владелец смотрит чек-лист; закрыт — журнал для месяца заперт. */
export const PERIOD_STATUSES = ["open", "review", "closed"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export function isPeriod(value: string): boolean {
  return PERIOD_PATTERN.test(value);
}

/** Границы месяца по UTC: с первого числа включительно до первого числа следующего. Не месяц — исключение. */
export function periodRange(period: string): { from: Date; to: Date } {
  const match = PERIOD_PATTERN.exec(period);
  if (match === null) throw new RangeError(`Месяц должен быть вида ГГГГ-ММ: «${period}»`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  // `Date.UTC` понимает годы 0–99 как 1900–1999, а `setUTCFullYear` — как есть
  const from = new Date(0);
  from.setUTCFullYear(year, month - 1, 1);
  const to = new Date(0);
  to.setUTCFullYear(year, month, 1);
  return { from, to };
}

/** Месяц кончился, только когда наступил следующий: на сверку идёт прошлый месяц или ещё более ранний. */
export function isEnded(period: string, now: Date): boolean {
  return period < periodOf(now);
}

/** Первый месяц года месяца: с него считается сумма чеков для лимита НПД. */
export function yearStart(period: string): string {
  return `${period.slice(0, 4)}-01`;
}

/** Следующий месяц: «2026-12» → «2027-01». */
export function nextPeriod(period: string): string {
  return periodOf(periodRange(period).to);
}

/**
 * Ключ проводки закрытия: месяц и номер раза. Закрытие снимают и делают заново, поэтому «раз» входит в ключ: ключи
 * первого раза остаются за сторнированными проводками, а второй раз пишет свои и не упирается в конфликт ключей.
 */
export function closeKey(period: string, round: number, suffix: string): string {
  return `${closePrefix(period, round)}${suffix}`;
}

/** Общее начало ключей одного раза закрытия; двоеточие в конце — чтобы `r1` не был началом `r10`. */
export function closePrefix(period: string, round: number): string {
  return `close:${period}:r${String(round)}:`;
}

/** Ключ сторно проводки закрытия: свой префикс, чтобы журнал различал закрытие и его снятие. */
export function reopenKey(closeSourceKey: string): string {
  if (!closeSourceKey.startsWith("close:")) throw new RangeError(`Ключ «${closeSourceKey}» — не проводка закрытия`);
  return `reopen:${closeSourceKey.slice("close:".length)}`;
}
