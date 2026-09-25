import { currency, type CurrencyKind } from "../currency.js";
import type { AcceptedRate } from "./rate.js";

/**
 * Свежесть курса. Упали все источники — остаётся последний курс с пометкой
 * «устарел», и потребитель решает сам: цены стоят, а продавать по
 * устаревшему можно не дольше заданного срока (docs/35-stage4-plan.md §3.12).
 * Здесь только сама пометка; что с ней делать — решает слой цен.
 */
export interface FreshnessRules {
  /** Через сколько мс без нового принятого значения курс считается устаревшим — по виду валюты. */
  maxAgeMs: Record<CurrencyKind, number>;
}

const HOUR_MS = 3_600_000;

/**
 * Рабочие значения (Р31). Фиат стабилен и опрашивается раз в сутки — двое
 * суток тишины значит, что и основной, и запасной источник молчат. Крипта
 * волатильна: час без котировки — уже устаревшая цена. Валюты площадок
 * задаются руками, и у них срок годности свой (`validUntil`), а этот предел —
 * страховка на случай курса без срока.
 */
export const DEFAULT_FRESHNESS: FreshnessRules = {
  maxAgeMs: { fiat: 48 * HOUR_MS, crypto: 1 * HOUR_MS, platform: 24 * 30 * HOUR_MS },
};

export type StaleReason = "source_silent" | "fixed_expired";

export interface StaleRate {
  rate: AcceptedRate;
  reason: StaleReason;
  /** На сколько мс просрочен. */
  overdueMs: number;
}

export function staleness(rate: AcceptedRate, now: number, rules: FreshnessRules): StaleRate | null {
  if (rate.validUntil !== undefined) {
    return now > rate.validUntil ? { rate, reason: "fixed_expired", overdueMs: now - rate.validUntil } : null;
  }
  const maxAge = rules.maxAgeMs[currency(rate.currency).kind];
  const age = now - rate.acceptedAt;
  return age > maxAge ? { rate, reason: "source_silent", overdueMs: age - maxAge } : null;
}

export function isStale(rate: AcceptedRate, now: number, rules: FreshnessRules): boolean {
  return staleness(rate, now, rules) !== null;
}

export function findStaleRates(rates: readonly AcceptedRate[], now: number, rules: FreshnessRules): StaleRate[] {
  const result: StaleRate[] = [];
  for (const rate of rates) {
    const stale = staleness(rate, now, rules);
    if (stale) result.push(stale);
  }
  return result;
}
