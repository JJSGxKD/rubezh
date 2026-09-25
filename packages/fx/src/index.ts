/**
 * Ядро модуля курсов (docs/35-stage4-plan.md, §3.12, Р32): валюты, курсы в
 * одном соглашении, пересчёт на `Decimal`, приём котировок, свежесть, бюджет
 * запросов источника. Ни игры, ни Nest, ни Prisma — только порты: этим же
 * ядром потом станет отдельный сервис курсов.
 */
export { acceptQuotes, deviation, median, type AcceptDecision, type AcceptPolicy } from "./accept.js";
export {
  RATE_LIMIT_PAUSE_MS,
  monthOf,
  nextPollDelayMs,
  pauseAfterRateLimit,
  recordPoll,
  type SourceUsage,
  type Tariff,
} from "./budget.js";
export { BASE_CURRENCY, CURRENCIES, CURRENCY_KINDS, currency, isCurrencyCode, type Currency, type CurrencyCode, type CurrencyKind } from "./currencies.js";
export { Decimal, decimal, positive, type DecimalInput } from "./decimal.js";
export { freshness, type Freshness, type FreshnessPolicy } from "./freshness.js";
export { MANUAL_RATE_PURPOSES, manualRate, manualToRate, type ManualRate, type ManualRatePurpose } from "./manual.js";
export { ACCEPT_POLICY, FRESHNESS_POLICY, HISTORY_REPEAT_MS, SOURCE_TIMEOUT_MS } from "./policy.js";
export { quoteFromUnitsPerUsd, quoteInUsd, quotesViaHome, type Quote } from "./quote.js";
export {
  MissingRateError,
  convert,
  crossRate,
  fromMinorUnits,
  payoutUsdPerUnit,
  rateOf,
  toMinorUnits,
  usdPerUnit,
  type MinorRounding,
  type Rate,
  type RatesSnapshot,
} from "./rates.js";
export { SourceRateLimitedError, SourceUnavailableError, matchBySourceId, type RateSource, type SourceCurrency } from "./sources.js";
export { MemoryRateStore } from "./memory-store.js";
export { refreshRates, takeSnapshot, type RateAlerts, type RefreshReport } from "./refresh.js";
export type { RateStore, SourceState, StoredRate } from "./store.js";
export { fetchBytes, fetchJson, retryAfterMs, type FetchLike } from "./sources/http.js";
export { CBR_CURRENCIES, ECB_CURRENCIES, ERAPI_CURRENCIES, createCbrSource, createEcbSource, createErApiSource, parseCbr, parseEcb } from "./sources/fiat.js";
export {
  BINANCE_CURRENCIES,
  COINGECKO_CURRENCIES,
  COINGECKO_TARIFFS,
  TONAPI_CURRENCIES,
  createBinanceSource,
  createCoinGeckoSource,
  createTonApiSource,
  type CoinGeckoKey,
} from "./sources/crypto.js";
