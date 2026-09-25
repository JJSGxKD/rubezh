/**
 * @bh/fx — курсы валют и цены (docs/35-stage4-plan.md §3.12, Р32–Р35).
 * Ядро без зависимостей от игры, Nest и Prisma: валюты, курсы, снимки,
 * сбор с источников, планировщик, слой цен и выручки. Всё внешнее — порты:
 * HTTP, часы, лок, хранилище, кеш, алерты.
 */
export { Decimal, DecimalError, type DecimalInput, type RoundingMode } from "./decimal.js";
export {
  CURRENCIES,
  CURRENCY_CODES,
  currency,
  findCurrencyProblems,
  fromMinorUnits,
  isCurrencyCode,
  REFERENCE_CURRENCY,
  resolveCurrencyCode,
  type Currency,
  type CurrencyCode,
  type CurrencyKind,
} from "./currency.js";

export { RATE_SCALE, rateKey, type AcceptedRate, type RateObservation, type RatePurpose } from "./rates/rate.js";
export { convert, createSnapshot, crossRate, hasStaleQuotes, MissingRateError, quoteOf, revenueInUsd, snapshotCurrencies, type CreateSnapshotInput, type RateSnapshot, type SnapshotQuote } from "./rates/snapshot.js";
export { cloneSnapshot, parseSnapshot, serializeSnapshot } from "./rates/snapshot-codec.js";
export { materializeSnapshot, type MaterializeSnapshotInput } from "./rates/snapshot-builder.js";
export { DEFAULT_FRESHNESS, findStaleRates, isStale, staleness, type FreshnessRules, type StaleRate, type StaleReason } from "./rates/freshness.js";
export { acceptedFromFixed, activeFixedRate, findFixedRateProblems, fixedRateAudit, parseFixedRateValue, type FixedRate, type FixedRateAudit } from "./rates/fixed-rates.js";
export { checkSpike, DEFAULT_SPIKE_RULES, relativeChange, type IndependentQuote, type SpikeRules, type SpikeVerdict } from "./rates/checks.js";
export { aggregate, median, type AggregationStrategy, type Aggregated, type Quote } from "./rates/aggregate.js";
export { assertHttpOk, SourceError, wantedIds, type QuoteCurrency, type SourceDefinition, type SourceErrorKind, type SourceFetchContext, type SourcePlan, type SourcePlanLimits, type SourceQuote } from "./rates/source.js";
export { binanceSource, cbrSource, coingeckoSource, DEFAULT_SOURCES, ecbSource, findSourceProblems, openErApiSource, tonapiSource } from "./rates/sources/index.js";
export {
  afterFailure,
  afterRateLimited,
  afterSuccess,
  DEFAULT_PLANNER_RULES,
  initialSourceState,
  isDue,
  isPaused,
  monthWindow,
  nextPollAt,
  pollIntervalMs,
  resolvePlan,
  type IntervalInput,
  type PlannerRules,
  type ResolvedPlan,
} from "./rates/planner.js";
export { resolveRates, type ResolveInput, type ResolveResult, type SourcedQuote } from "./rates/resolve.js";
export {
  COLLECT_LOCK_KEY,
  collectRates,
  currentAcceptedRates,
  DEFAULT_COLLECT_RULES,
  type CollectReport,
  type CollectRules,
  type CollectorDeps,
  type ConfiguredSource,
  type SourceOutcome,
  type SourceOutcomeStatus,
} from "./rates/collector.js";

export { FixedClock, systemClock, type Clock } from "./ports/clock.js";
export { MemoryLock, noLock, type Lock, type LockOutcome } from "./ports/lock.js";
export { fetchHttpClient, HttpTimeoutError, StubHttpClient, type FetchLike, type HttpClient, type HttpRequest, type HttpResponse } from "./ports/http.js";
export { CollectingAlerts, noAlerts, type FxAlert, type FxAlerts, type RateRejectedAlert, type RateStaleAlert } from "./ports/alerts.js";
export { type RateStore, type SourceRequestLog, type SourceState } from "./ports/store.js";
export { MemoryRateStore } from "./ports/memory-store.js";
export { MemoryRateCache, type RateCache } from "./ports/cache.js";

export * from "./pricing/index.js";
