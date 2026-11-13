/**
 * Правила долей участников проекта (docs/35-stage4-plan.md Р217, tasks/T-0452): чистые функции без Nest и
 * Prisma — месяц, доля на месяц, предел суммы, перевод процентов.
 *
 * Месяц — строка `ГГГГ-ММ` по UTC: у долей нет времени внутри месяца, а строки одинаковой ширины сравниваются
 * как обычный текст, поэтому «раньше или позже» не требует разбора дат. Доля — целое число базисных пунктов
 * (сотых долей процента): проценты с двумя знаками не копят ошибку плавающей точки на суммах.
 */

/** Сто процентов в базисных пунктах: сумма долей участников на любой месяц не больше этого. */
export const MAX_SHARE_BP = 10_000;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Допуск сравнения «проценты с двумя знаками»: плавающая точка даёт хвосты порядка 1e-14, лишний знак — 1e-3. */
const PERCENT_EPSILON = 1e-9;

/** Запись о доле: аккаунт, месяц начала и доля с него. */
export interface ShareRecord {
  accountId: string;
  /** `ГГГГ-ММ`: первое число этого месяца по UTC */
  fromMonth: string;
  /** сотые доли процента: 2 550 — 25,5 % */
  shareBp: number;
}

/** Месяц, на котором сумма долей выходит за предел, и сама сумма. */
export interface OverLimit {
  month: string;
  totalBp: number;
}

/** `ГГГГ-ММ` по UTC. */
export function monthKey(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Первое число месяца 00:00 UTC; строка не вида `ГГГГ-ММ` — исключение. */
export function parseMonth(value: string): Date {
  const match = MONTH.exec(value);
  if (match === null) throw new RangeError(`Месяц должен быть вида ГГГГ-ММ: «${value}»`);
  // `Date.UTC` понимает годы 0–99 как 1900–1999, а `setUTCFullYear` — как есть
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, 1);
  return date;
}

/**
 * Доля в базисных пунктах на месяц: последняя запись с `fromMonth` не позже месяца, а если такой нет — ноль.
 * Порядок записей в списке не важен.
 */
export function shareAt(history: readonly Pick<ShareRecord, "fromMonth" | "shareBp">[], month: string): number {
  let found: Pick<ShareRecord, "fromMonth" | "shareBp"> | null = null;
  for (const record of history) {
    if (record.fromMonth <= month && (found === null || record.fromMonth > found.fromMonth)) found = record;
  }
  return found === null ? 0 : found.shareBp;
}

/**
 * Не выходит ли сумма долей за 100 % после изменения. Изменение применяется к списку — запись того же
 * участника и месяца заменяется, иначе добавляется, — и сумма проверяется на месяце начала и на каждом месяце
 * после него, где у кого-то из участников есть запись: между такими месяцами сумма не меняется, поэтому
 * проверять каждый месяц подряд не нужно. Раньше месяца изменения не смотрим: прошлое не пересчитывается.
 * Ответ — первый месяц с превышением, иначе `null`.
 */
export function overLimit(all: readonly ShareRecord[], change: ShareRecord): OverLimit | null {
  const after = all.filter((record) => !(record.accountId === change.accountId && record.fromMonth === change.fromMonth));
  after.push(change);

  const byAccount = new Map<string, ShareRecord[]>();
  for (const record of after) {
    const list = byAccount.get(record.accountId);
    if (list === undefined) byAccount.set(record.accountId, [record]);
    else list.push(record);
  }

  const months = [...new Set(after.map((record) => record.fromMonth).filter((month) => month >= change.fromMonth))].sort();
  for (const month of months) {
    let totalBp = 0;
    for (const history of byAccount.values()) totalBp += shareAt(history, month);
    if (totalBp > MAX_SHARE_BP) return { month, totalBp };
  }
  return null;
}

/**
 * Проценты с двумя знаками в базисные пункты без ошибок плавающей точки: `0.1 + 0.2` — это 30, а не
 * 30,000000000000004. Вне 0…100 и с тремя знаками и больше — исключение: молча округлить долю денег нельзя.
 */
export function percentToBp(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError("Доля — число от 0 до 100");
  const bp = Math.round(value * 100);
  if (Math.abs(bp / 100 - value) > PERCENT_EPSILON) throw new RangeError("Доля — не больше двух знаков после запятой");
  return bp;
}

const MONTH_NAMES_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;

/** «декабря 2026» для текста ошибки: `С декабря 2026 …`. */
export function monthLabel(month: string): string {
  const match = MONTH.exec(month);
  if (match === null) return month;
  return `${MONTH_NAMES_GENITIVE[Number(match[2]) - 1] ?? ""} ${match[1]}`;
}

/** Базисные пункты процентами по-русски: 11 050 — «110,5», 11 000 — «110». */
export function formatBp(bp: number): string {
  return String(bp / 100).replace(".", ",");
}
