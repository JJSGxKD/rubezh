import { CURRENCY_CODES, type CurrencyCode } from "../currency.js";
import type { FxAlerts, RateRejectedAlert, RateStaleAlert } from "../ports/alerts.js";
import type { Clock } from "../ports/clock.js";
import type { HttpClient } from "../ports/http.js";
import type { Lock } from "../ports/lock.js";
import type { RateStore, SourceState } from "../ports/store.js";
import { DEFAULT_SPIKE_RULES, type SpikeRules } from "./checks.js";
import { acceptedFromFixed } from "./fixed-rates.js";
import { DEFAULT_FRESHNESS, findStaleRates, type FreshnessRules } from "./freshness.js";
import {
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
  type PlannerRules,
} from "./planner.js";
import { rateKey, type AcceptedRate } from "./rate.js";
import { resolveRates, type SourcedQuote } from "./resolve.js";
import { SourceError, type SourceDefinition } from "./source.js";

/**
 * Один цикл сбора курсов (docs/35-stage4-plan.md §3.12): опросить источники,
 * которым пора, свести котировки, проверить скачки, записать историю и
 * принятые курсы, поднять алерты. Расписание циклов — дело модуля бэкенда;
 * пакет только говорит, кому пора, а кому нет.
 */
export interface ConfiguredSource {
  source: SourceDefinition;
  /** Ключ платного тарифа из окружения; пустой — бесплатный тариф. */
  apiKey?: string;
  enabled?: boolean;
}

export interface CollectRules {
  spike: SpikeRules;
  freshness: FreshnessRules;
  planner: PlannerRules;
  requestTimeoutMs: number;
  lockTtlMs: number;
  /** Какие валюты собираем; у остальных курс задаётся руками. */
  currencies: readonly CurrencyCode[];
  /** Приоритет источников для фиата: первый — официальный курс. */
  fiatPriority: readonly string[];
}

export const DEFAULT_COLLECT_RULES: CollectRules = {
  spike: DEFAULT_SPIKE_RULES,
  freshness: DEFAULT_FRESHNESS,
  planner: DEFAULT_PLANNER_RULES,
  requestTimeoutMs: 10_000,
  lockTtlMs: 120_000,
  currencies: CURRENCY_CODES.filter((code) => code !== "USD" && code !== "XTR"),
  fiatPriority: ["cbr", "ecb", "open-er-api"],
};

export interface CollectorDeps {
  sources: readonly ConfiguredSource[];
  http: HttpClient;
  store: RateStore;
  clock: Clock;
  lock: Lock;
  alerts: FxAlerts;
  rules: CollectRules;
}

export type SourceOutcomeStatus = "ok" | "disabled" | "paused" | "not_due" | "rate_limited" | "error" | "lock_lost";

export interface SourceOutcome {
  sourceId: string;
  status: SourceOutcomeStatus;
  plan: "free" | "paid";
  quotes: number;
  nextPollAt: number | null;
  error?: string;
}

export interface CollectReport {
  at: number;
  /** false — цикл шёл на другой реплике, здесь ничего не делали */
  locked: boolean;
  sources: SourceOutcome[];
  accepted: AcceptedRate[];
  rejected: RateRejectedAlert[];
  stale: RateStaleAlert[];
  unresolved: number;
}

export const COLLECT_LOCK_KEY = "fx:collect";

interface PollResult {
  outcome: SourceOutcome;
  quotes: SourcedQuote[];
  state: SourceState;
}

async function pollSource(entry: ConfiguredSource, deps: CollectorDeps, now: number): Promise<PollResult> {
  const { source } = entry;
  const resolved = resolvePlan(source, entry.apiKey);
  const planName = resolved.plan.name;
  const state = (await deps.store.sourceState(source.id)) ?? initialSourceState(source.id);
  const window = monthWindow(now);
  const monthRequests = await deps.store.countRequests(source.id, window.start, window.end);
  const interval = pollIntervalMs({ source, plan: resolved.plan, monthRequests, now, rules: deps.rules.planner });
  const skip = (status: SourceOutcomeStatus): PollResult => ({ outcome: { sourceId: source.id, status, plan: planName, quotes: 0, nextPollAt: nextPollAt(state, interval) }, quotes: [], state });

  if (entry.enabled === false) return skip("disabled");
  if (isPaused(state, now)) return skip("paused");
  if (!isDue(state, interval, now)) return skip("not_due");

  try {
    const fetched = await source.fetch({ http: deps.http, plan: resolved.plan, apiKey: resolved.apiKey, currencies: deps.rules.currencies, timeoutMs: deps.rules.requestTimeoutMs, now });
    await deps.store.logRequest({ sourceId: source.id, at: now, ok: true, status: 200 });
    const next = afterSuccess(state, now);
    return { outcome: { sourceId: source.id, status: "ok", plan: planName, quotes: fetched.length, nextPollAt: nextPollAt(next, interval) }, quotes: fetched.map((quote) => ({ ...quote, sourceId: source.id })), state: next };
  } catch (error) {
    const rateLimited = error instanceof SourceError && error.kind === "rate_limited";
    const status = error instanceof SourceError ? error.status : null;
    await deps.store.logRequest({ sourceId: source.id, at: now, ok: false, status });
    const next = rateLimited ? afterRateLimited(state, now, deps.rules.planner) : afterFailure(state, now);
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: { sourceId: source.id, status: rateLimited ? "rate_limited" : "error", plan: planName, quotes: 0, nextPollAt: nextPollAt(next, interval), error: message }, quotes: [], state: next };
  }
}

/** Принятые с рынка плюс действующие заданные: заданный курс валюты площадки перекрывает рыночный, если такой вдруг появился. */
export async function currentAcceptedRates(store: RateStore, now: number): Promise<AcceptedRate[]> {
  const byKey = new Map<string, AcceptedRate>();
  for (const rate of await store.latestAccepted()) byKey.set(rateKey(rate.currency, rate.purpose), rate);
  for (const rate of acceptedFromFixed(await store.fixedRates(), now)) byKey.set(rateKey(rate.currency, rate.purpose), rate);
  return [...byKey.values()];
}

export async function collectRates(deps: CollectorDeps): Promise<CollectReport> {
  const now = deps.clock.now();
  const outcome = await deps.lock.withLock(COLLECT_LOCK_KEY, deps.rules.lockTtlMs, async (held) => {
    const outcomes: SourceOutcome[] = [];
    const quotes: SourcedQuote[] = [];

    for (const entry of deps.sources) {
      if (!held()) {
        outcomes.push({ sourceId: entry.source.id, status: "lock_lost", plan: resolvePlan(entry.source, entry.apiKey).plan.name, quotes: 0, nextPollAt: null });
        continue;
      }
      const result = await pollSource(entry, deps, now);
      outcomes.push(result.outcome);
      quotes.push(...result.quotes);
      if (result.outcome.status !== "disabled" && result.outcome.status !== "paused" && result.outcome.status !== "not_due") {
        await deps.store.saveSourceState(result.state);
      }
    }

    const previous = new Map<CurrencyCode, AcceptedRate>();
    for (const rate of await deps.store.latestAccepted()) if (rate.purpose === "price") previous.set(rate.currency, rate);

    const resolved = resolveRates({ quotes, previous, spike: deps.rules.spike, fiatPriority: deps.rules.fiatPriority, now });
    if (resolved.observations.length > 0) await deps.store.appendObservations(resolved.observations);
    if (resolved.accepted.length > 0) await deps.store.saveAccepted(resolved.accepted);
    for (const alert of resolved.rejected) deps.alerts.emit(alert);

    const stale: RateStaleAlert[] = findStaleRates(await currentAcceptedRates(deps.store, now), now, deps.rules.freshness).map((entry) => ({
      kind: "rate_stale",
      currency: entry.rate.currency,
      purpose: entry.rate.purpose,
      reason: entry.reason,
      overdueMs: entry.overdueMs,
      lastAcceptedAt: entry.rate.acceptedAt,
      at: now,
    }));
    for (const alert of stale) deps.alerts.emit(alert);

    return { at: now, locked: true, sources: outcomes, accepted: resolved.accepted, rejected: resolved.rejected, stale, unresolved: resolved.unresolved.length } satisfies CollectReport;
  });

  if (!outcome.acquired) return { at: now, locked: false, sources: [], accepted: [], rejected: [], stale: [], unresolved: 0 };
  return outcome.result;
}
