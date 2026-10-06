import { acceptQuotes, type AcceptDecision } from "./accept.js";
import { nextPollDelayMs, pauseAfterRateLimit, recordPoll, type SourceUsage } from "./budget.js";
import { BASE_CURRENCY, CURRENCIES, type CurrencyCode } from "./currencies.js";
import { Decimal } from "./decimal.js";
import { freshness, type Freshness } from "./freshness.js";
import { manualToRate, type ManualRatePurpose } from "./manual.js";
import { ACCEPT_POLICY, FRESHNESS_POLICY, HISTORY_REPEAT_MS, SOURCE_TIMEOUT_MS } from "./policy.js";
import type { Rate, RatesSnapshot } from "./rates.js";
import { SourceRateLimitedError, type RateSource } from "./sources.js";
import type { RateStore, StoredRate } from "./store.js";

/**
 * Один проход обновления курсов (docs/35-stage4-plan.md, §3.12). Расписание
 * и распределённый лок — забота того, кто вызывает: у бэкенда игры это
 * планировщик под локом Redis. Сам проход безопасно повторять.
 *
 * 1. Источники, которым пора, опрашиваются — каждый со своим сроком и в своём
 *    бюджете. Отказ одного не мешает другим.
 * 2. По каждой валюте, о которой пришли новые котировки, решается, принять ли
 *    курс: медиана последних голосов всех источников, проверка скачка.
 * 3. Свежесть всех курсов — молчание источника не должно выдать старый курс
 *    за свежий.
 */

export interface RateAlerts {
  /** скачок без подтверждения или несогласные источники — `rate_rejected` */
  rejected(currency: CurrencyCode, decision: Extract<AcceptDecision, { status: "rejected" }>): void;
  /** курс устарел, просрочен или его нет вовсе — `rate_stale` */
  stale(currency: CurrencyCode, state: Exclude<Freshness, "fresh"> | "missing", purpose?: ManualRatePurpose): void;
  /** источник не ответил; лимит — не отказ: он просто ждёт своей паузы */
  sourceFailed(source: string, reason: string): void;
}

export interface RefreshReport {
  polled: string[];
  failed: string[];
  accepted: CurrencyCode[];
  rejected: CurrencyCode[];
  stale: CurrencyCode[];
}

export async function refreshRates(input: { sources: readonly RateSource[]; store: RateStore; alerts: RateAlerts; now: Date }): Promise<RefreshReport> {
  const { store, alerts, now } = input;
  const report: RefreshReport = { polled: [], failed: [], accepted: [], rejected: [], stale: [] };
  const touched = new Set<CurrencyCode>();

  for (const source of input.sources) {
    const state = await store.sourceState(source.id);
    if (state !== null && state.nextPollAt > now) continue;
    const usage: SourceUsage = state?.usage ?? { month: "", used: 0, pausedUntil: null };
    try {
      const quotes = await source.fetch(AbortSignal.timeout(SOURCE_TIMEOUT_MS));
      await store.saveQuotes(quotes);
      for (const quote of quotes) touched.add(quote.currency);
      const polled = recordPoll(usage, now);
      await store.saveSourceState(source.id, { usage: polled, nextPollAt: new Date(now.getTime() + nextPollDelayMs(source.tariff, polled, now)) });
      report.polled.push(source.id);
    } catch (error: unknown) {
      // Отказ — тоже запрос из бюджета: лимит источника считает и ошибки.
      const counted = recordPoll(usage, now);
      const next =
        error instanceof SourceRateLimitedError
          ? pauseAfterRateLimit(counted, now, error.retryAfterMs)
          : counted;
      await store.saveSourceState(source.id, { usage: next, nextPollAt: new Date(now.getTime() + nextPollDelayMs(source.tariff, next, now)) });
      if (!(error instanceof SourceRateLimitedError)) alerts.sourceFailed(source.id, error instanceof Error ? error.message : "неизвестно");
      report.failed.push(source.id);
    }
  }

  for (const code of touched) {
    const kind = CURRENCIES[code].kind;
    if (kind === "platform" || code === BASE_CURRENCY) continue;
    const previous = await store.currentRate(code);
    const decision = acceptQuotes({ currency: code, previous, quotes: await store.latestQuotes(code), now, policy: ACCEPT_POLICY[kind] });
    if (decision.status === "accepted") {
      await store.setCurrentRate(decision.rate, now);
      if (worthRecording(decision.rate, previous, await store.lastHistoryAt(code), now)) await store.appendHistory(decision.rate, now);
      report.accepted.push(code);
    } else if (decision.status === "rejected") {
      alerts.rejected(code, decision);
      report.rejected.push(code);
    }
  }

  for (const [code, state] of await freshnessOf(store, now)) {
    alerts.stale(code, state.state, state.purpose);
    if (!report.stale.includes(code)) report.stale.push(code);
  }
  return report;
}

/**
 * Снимок на сейчас: принятые курсы и действующие заданные. Просроченный курс в
 * снимок не попадает — пересчёт по нему упадёт с «нет курса», и продажа по
 * нему не состоится (§3.12: продавать по устаревшему — не дольше срока).
 */
export async function takeSnapshot(store: RateStore, now: Date): Promise<RatesSnapshot> {
  const rates = new Map<CurrencyCode, Rate>();
  const payout = new Map<CurrencyCode, Rate>();
  const codes = (Object.keys(CURRENCIES) as CurrencyCode[]).filter((code) => code !== BASE_CURRENCY);

  // Сначала рыночные курсы: через них переводятся заданные в рублях.
  for (const code of codes) {
    const kind = CURRENCIES[code].kind;
    if (kind === "platform") continue;
    const rate = await store.currentRate(code);
    if (rate !== null && freshness(rate.observedAt, now, FRESHNESS_POLICY[kind]) !== "expired") rates.set(code, stripAccepted(rate));
  }
  for (const code of codes) {
    if (CURRENCIES[code].kind !== "platform") continue;
    for (const purpose of ["price", "payout"] as const) {
      const manual = await store.currentManual(code, purpose);
      if (manual === null || freshness(manual.expiresAt, now, FRESHNESS_POLICY.platform) === "expired") continue;
      // Котировки нет в снимке — курс рубля просрочен или ещё не принят:
      // посчитать звезду не через что, и продавать по догадке нельзя.
      const quote = manual.quote === BASE_CURRENCY ? new Decimal(1) : rates.get(manual.quote)?.usdPerUnit;
      if (quote === undefined) continue;
      (purpose === "price" ? rates : payout).set(code, manualToRate(manual, quote));
    }
  }
  return await store.saveSnapshot({ takenAt: now, rates, payout });
}

/**
 * В историю — курс, который изменился, или тот же, но не чаще раза в час:
 * три источника крипты раз в пять минут иначе писали бы по строке на
 * каждый опрос, а история нужна, чтобы восстановить курс на момент, а не
 * каждое его подтверждение.
 */
function worthRecording(rate: Rate, previous: StoredRate | null, lastHistoryAt: Date | null, now: Date): boolean {
  if (previous === null || lastHistoryAt === null) return true;
  if (!rate.usdPerUnit.equals(previous.usdPerUnit)) return true;
  return now.getTime() - lastHistoryAt.getTime() >= HISTORY_REPEAT_MS;
}

function stripAccepted(rate: StoredRate): Rate {
  return { currency: rate.currency, usdPerUnit: rate.usdPerUnit, sources: rate.sources, observedAt: rate.observedAt };
}

async function freshnessOf(store: RateStore, now: Date): Promise<[CurrencyCode, { state: Exclude<Freshness, "fresh"> | "missing"; purpose?: ManualRatePurpose }][]> {
  const problems: [CurrencyCode, { state: Exclude<Freshness, "fresh"> | "missing"; purpose?: ManualRatePurpose }][] = [];
  for (const code of Object.keys(CURRENCIES) as CurrencyCode[]) {
    if (code === BASE_CURRENCY) continue;
    const kind = CURRENCIES[code].kind;
    if (kind !== "platform") {
      const rate = await store.currentRate(code);
      const state = rate === null ? "missing" : freshness(rate.observedAt, now, FRESHNESS_POLICY[kind]);
      if (state !== "fresh") problems.push([code, { state }]);
      continue;
    }
    for (const purpose of ["price", "payout"] as const) {
      const manual = await store.currentManual(code, purpose);
      const state = manual === null ? "missing" : freshness(manual.expiresAt, now, FRESHNESS_POLICY.platform);
      if (state !== "fresh") problems.push([code, { state, purpose }]);
    }
  }
  return problems;
}
