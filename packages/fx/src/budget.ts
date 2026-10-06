/**
 * Бюджет запросов источника (docs/35-stage4-plan.md, §3.12, Р35). Ключей
 * нет — все источники на бесплатных тарифах, и частота опроса считается из
 * их лимитов, а не выбирается на глаз.
 *
 * - интервал — не короче, чем позволяет лимит в минуту, и не короче
 *   минимального для источника (фиату хватает раза в сутки);
 * - месячный лимит **растягивается** на остаток месяца: остаток запросов
 *   делится на остаток времени. Выбрали лишнее в начале — к концу месяца
 *   опрос реже сам, а не отказ `429` за неделю до конца;
 * - отказ по лимиту — пауза этого источника, а не ошибка модуля.
 *
 * **Ключ — настройкой, а не кодом.** Тариф выбирает фабрика адаптера по
 * тому, какой ключ ей передали: у CoinGecko без ключа — общий лимит по
 * адресу, с бесплатным демо-ключом — свой месячный, с платным — другой адрес
 * и лимиты. Пары «бесплатный — платный» на всех не хватило бы. Интервал
 * уплотняется из лимитов выбранного тарифа сам.
 */

export interface Tariff {
  name: string;
  /** запросов в минуту */
  perMinute: number;
  /** запросов в календарный месяц по UTC; `null` — месячного лимита нет */
  perMonth: number | null;
  /** реже этого опрашивать незачем: курс у источника меняется не чаще */
  minIntervalMs: number;
}

export interface SourceUsage {
  /** `ГГГГ-ММ` по UTC — месяц, к которому относится `used` */
  month: string;
  used: number;
  /** после `429` — до какого момента не спрашивать */
  pausedUntil: Date | null;
}

/** Пауза после отказа по лимиту, если источник не сказал `Retry-After`. */
export const RATE_LIMIT_PAUSE_MS = 15 * 60_000;

export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** Через сколько спрашивать источник снова. `requestsPerPoll` — запросов на один опрос всех его валют. */
export function nextPollDelayMs(tariff: Tariff, usage: SourceUsage, now: Date, requestsPerPoll = 1): number {
  if (usage.pausedUntil !== null && usage.pausedUntil > now) return usage.pausedUntil.getTime() - now.getTime();

  const perMinuteGap = (60_000 / tariff.perMinute) * requestsPerPoll;
  let monthlyGap = 0;
  if (tariff.perMonth !== null) {
    const used = usage.month === monthOf(now) ? usage.used : 0;
    const left = tariff.perMonth - used;
    const monthEnd = nextMonthStart(now).getTime();
    // Остатка на опрос не хватает — ждём нового месяца, а не отказа.
    if (left < requestsPerPoll) return monthEnd - now.getTime();
    monthlyGap = (monthEnd - now.getTime()) / Math.floor(left / requestsPerPoll);
  }
  return Math.ceil(Math.max(tariff.minIntervalMs, perMinuteGap, monthlyGap));
}

/** Учесть сделанный опрос; с новым месяцем счётчик начинается заново. */
export function recordPoll(usage: SourceUsage, now: Date, requests = 1): SourceUsage {
  const month = monthOf(now);
  return { month, used: (usage.month === month ? usage.used : 0) + requests, pausedUntil: null };
}

export function pauseAfterRateLimit(usage: SourceUsage, now: Date, retryAfterMs: number | null): SourceUsage {
  return { ...usage, pausedUntil: new Date(now.getTime() + Math.max(retryAfterMs ?? 0, RATE_LIMIT_PAUSE_MS)) };
}

function nextMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}
