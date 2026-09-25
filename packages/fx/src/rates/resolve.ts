import { currency, type CurrencyCode } from "../currency.js";
import type { Decimal } from "../decimal.js";
import type { RateRejectedAlert } from "../ports/alerts.js";
import { aggregate, median, type Quote } from "./aggregate.js";
import { checkSpike, type SpikeRules } from "./checks.js";
import { RATE_SCALE, type AcceptedRate, type RateObservation } from "./rate.js";
import type { SourceQuote } from "./source.js";

/**
 * От котировок источников — к принятым курсам: пересчёт котировок в USDT,
 * свод по валюте, проверка скачка. Чистая функция цикла сбора, отделённая от
 * ходьбы в сеть и хранилище, чтобы её можно было проверить на таблице чисел.
 */
export interface SourcedQuote extends SourceQuote {
  sourceId: string;
}

export interface ResolveInput {
  quotes: readonly SourcedQuote[];
  /** Последние принятые курсы цены по валютам — с ними сравнивается скачок. */
  previous: ReadonlyMap<CurrencyCode, AcceptedRate>;
  spike: SpikeRules;
  /** Приоритет источников для валют, у которых берётся один источник, а не медиана. */
  fiatPriority: readonly string[];
  now: number;
}

export interface ResolveResult {
  accepted: AcceptedRate[];
  observations: RateObservation[];
  rejected: RateRejectedAlert[];
  /** Котировки в USDT, которые не удалось перевести в доллары: курса USDT нет ни в цикле, ни в истории. */
  unresolved: SourcedQuote[];
}

/** Курс USDT в долларах на этот цикл: медиана долларовых котировок, иначе — последний принятый. */
function usdtInUsd(quotes: readonly SourcedQuote[], previous: ReadonlyMap<CurrencyCode, AcceptedRate>): Decimal | null {
  const direct = quotes.filter((quote) => quote.currency === "USDT" && quote.quotedIn === "USD").map((quote) => quote.price);
  if (direct.length > 0) return median(direct);
  return previous.get("USDT")?.usdPerUnit ?? null;
}

export function resolveRates(input: ResolveInput): ResolveResult {
  const usdt = usdtInUsd(input.quotes, input.previous);
  const byCurrency = new Map<CurrencyCode, Array<Quote & { sourceCurrencyId: string; observedAt: number }>>();
  const unresolved: SourcedQuote[] = [];

  for (const quote of input.quotes) {
    let usdPerUnit: Decimal;
    if (quote.quotedIn === "USD") usdPerUnit = quote.price;
    else if (usdt) usdPerUnit = quote.price.mul(usdt).round(RATE_SCALE);
    else {
      unresolved.push(quote);
      continue;
    }
    const list = byCurrency.get(quote.currency) ?? [];
    list.push({ sourceId: quote.sourceId, usdPerUnit, sourceCurrencyId: quote.sourceCurrencyId, observedAt: quote.observedAt });
    byCurrency.set(quote.currency, list);
  }

  const accepted: AcceptedRate[] = [];
  const observations: RateObservation[] = [];
  const rejected: RateRejectedAlert[] = [];

  for (const [code, quotes] of byCurrency) {
    for (const quote of quotes) {
      observations.push({ currency: code, sourceId: quote.sourceId, sourceCurrencyId: quote.sourceCurrencyId, usdPerUnit: quote.usdPerUnit, observedAt: quote.observedAt });
    }

    const strategy = currency(code).kind === "crypto" ? "median" : "priority";
    const aggregated = aggregate(quotes, strategy, input.fiatPriority);
    if (!aggregated) continue;

    const previous = input.previous.get(code) ?? null;
    const verdict = checkSpike(previous?.usdPerUnit ?? null, aggregated.usdPerUnit, quotes, input.spike);
    if (!verdict.ok) {
      rejected.push({
        kind: "rate_rejected",
        currency: code,
        previous: previous!.usdPerUnit,
        candidate: aggregated.usdPerUnit,
        jumpRatio: verdict.jumpRatio,
        sources: aggregated.sources,
        confirmedBy: verdict.confirmedBy,
        at: input.now,
      });
      continue;
    }
    accepted.push({ currency: code, purpose: "price", usdPerUnit: aggregated.usdPerUnit, sources: aggregated.sources, acceptedAt: input.now, fixed: false });
  }

  return { accepted, observations, rejected, unresolved };
}
