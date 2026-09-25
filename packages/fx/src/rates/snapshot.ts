import { isCurrencyCode, REFERENCE_CURRENCY, type CurrencyCode } from "../currency.js";
import { Decimal } from "../decimal.js";
import { type FreshnessRules, isStale } from "./freshness.js";
import { RATE_SCALE, type AcceptedRate } from "./rate.js";

/**
 * Снимок курсов — набор курсов на момент, с идентификатором. Цена и платёж
 * ссылаются на снимок, по которому посчитаны, поэтому выручка
 * пересчитывается задним числом воспроизводимо (docs/35-stage4-plan.md §3.12).
 */
export interface SnapshotQuote {
  /** Цена единицы в долларах — для цен. */
  usdPerUnit: Decimal;
  /** Для выручки: у звёзд — сколько получаем при выводе; у остальных совпадает с `usdPerUnit`. */
  revenueUsdPerUnit: Decimal;
  stale: boolean;
  acceptedAt: number;
  sources: readonly string[];
}

export interface RateSnapshot {
  id: string;
  /** мс UTC — момент снимка */
  at: number;
  reference: CurrencyCode;
  quotes: Partial<Record<CurrencyCode, SnapshotQuote>>;
}

export class MissingRateError extends Error {
  constructor(readonly currency: CurrencyCode, readonly snapshotId: string) {
    super(`в снимке ${snapshotId} нет курса ${currency}`);
    this.name = "MissingRateError";
  }
}

export interface CreateSnapshotInput {
  /** Идентификатор выдаёт вызывающий: пакет не знает, uuid у нас или ulid. */
  id: string;
  at: number;
  accepted: readonly AcceptedRate[];
  freshness: FreshnessRules;
}

/**
 * Снимок из принятых курсов. Опорная валюта всегда внутри с курсом 1 —
 * иначе пересчёт «в доллары» падал бы на отсутствующем курсе доллара.
 */
export function createSnapshot(input: CreateSnapshotInput): RateSnapshot {
  const quotes: Partial<Record<CurrencyCode, SnapshotQuote>> = {};
  const revenue = new Map<CurrencyCode, AcceptedRate>();

  for (const rate of input.accepted) {
    if (rate.purpose === "revenue") {
      revenue.set(rate.currency, rate);
      continue;
    }
    quotes[rate.currency] = {
      usdPerUnit: rate.usdPerUnit,
      revenueUsdPerUnit: rate.usdPerUnit,
      stale: isStale(rate, input.at, input.freshness),
      acceptedAt: rate.acceptedAt,
      sources: rate.sources,
    };
  }
  for (const [code, rate] of revenue) {
    const quote = quotes[code];
    if (!quote) continue;
    quotes[code] = {
      ...quote,
      revenueUsdPerUnit: rate.usdPerUnit,
      // Просроченный курс выручки делает устаревшим весь снимок валюты:
      // выручку по нему считать нельзя, а цену без пары — не стоит.
      stale: quote.stale || isStale(rate, input.at, input.freshness),
    };
  }
  quotes[REFERENCE_CURRENCY] = {
    usdPerUnit: Decimal.ONE,
    revenueUsdPerUnit: Decimal.ONE,
    stale: false,
    acceptedAt: input.at,
    sources: ["reference"],
  };

  return { id: input.id, at: input.at, reference: REFERENCE_CURRENCY, quotes };
}

export function quoteOf(snapshot: RateSnapshot, code: CurrencyCode): SnapshotQuote {
  const quote = snapshot.quotes[code];
  if (!quote) throw new MissingRateError(code, snapshot.id);
  return quote;
}

/** Сколько единиц `to` стоит одна единица `from` — через опорную валюту. */
export function crossRate(from: CurrencyCode, to: CurrencyCode, snapshot: RateSnapshot, places: number = RATE_SCALE): Decimal {
  if (from === to) return Decimal.ONE;
  return quoteOf(snapshot, from).usdPerUnit.div(quoteOf(snapshot, to).usdPerUnit, places);
}

/**
 * Пересчёт суммы. Умножение точное, деление — в `places` знаков: округлять
 * до разрядности валюты здесь рано, это делает правило округления цены.
 */
export function convert(amount: Decimal, from: CurrencyCode, to: CurrencyCode, snapshot: RateSnapshot, places: number = RATE_SCALE): Decimal {
  if (from === to) return amount;
  return amount.mul(quoteOf(snapshot, from).usdPerUnit).div(quoteOf(snapshot, to).usdPerUnit, places);
}

/** То же для выручки: доллары, которые мы получим за сумму в валюте оплаты. */
export function revenueInUsd(amount: Decimal, from: CurrencyCode, snapshot: RateSnapshot): Decimal {
  return amount.mul(quoteOf(snapshot, from).revenueUsdPerUnit);
}

export function hasStaleQuotes(snapshot: RateSnapshot, codes: readonly CurrencyCode[]): boolean {
  return codes.some((code) => snapshot.quotes[code]?.stale === true);
}

/** Коды валют снимка — только известные: снимок из базы мог быть записан сборкой с другим реестром. */
export function snapshotCurrencies(snapshot: RateSnapshot): CurrencyCode[] {
  return Object.keys(snapshot.quotes).filter(isCurrencyCode);
}
