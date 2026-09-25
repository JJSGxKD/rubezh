import type { SourceState } from "../ports/store.js";
import type { SourceDefinition, SourcePlan } from "./source.js";

/**
 * Планировщик опроса (docs/35-stage4-plan.md §3.12, «Бюджет запросов»).
 * Интервал считается из лимитов тарифа и природной частоты данных, месячный
 * бюджет растягивается до конца месяца, отказ по лимиту ставит источник на
 * паузу. Всё — чистые функции от состояния и часов: расписание проверяется
 * тестом, а не наблюдением за продом.
 */
export interface PlannerRules {
  /** Доля месячного бюджета, которую не тратим: наш счётчик и счётчик источника могут разойтись. */
  monthlyReserveRatio: number;
  /** Ниже этого интервала не опускаемся ни при каком тарифе: чаще курсы никому не нужны. */
  minIntervalMs: number;
  /** Пауза после первого отказа по лимиту; каждый следующий подряд удваивает её до потолка. */
  rateLimitPauseBaseMs: number;
  rateLimitPauseMaxMs: number;
}

const MINUTE_MS = 60_000;

export const DEFAULT_PLANNER_RULES: PlannerRules = {
  monthlyReserveRatio: 0.1,
  minIntervalMs: MINUTE_MS,
  rateLimitPauseBaseMs: 5 * MINUTE_MS,
  rateLimitPauseMaxMs: 6 * 60 * MINUTE_MS,
};

export interface ResolvedPlan {
  plan: SourcePlan;
  apiKey: string | undefined;
  paid: boolean;
}

/**
 * Тариф — по наличию ключа. Нет ключа — бесплатный; есть ключ и у источника
 * есть платный тариф — платный, с его адресом и лимитами. Ключ у источника
 * без платного тарифа не используется: слать его некуда.
 */
export function resolvePlan(source: SourceDefinition, apiKey: string | undefined): ResolvedPlan {
  if (apiKey && source.paid) return { plan: source.paid, apiKey, paid: true };
  return { plan: source.free, apiKey: undefined, paid: false };
}

/** Календарный месяц по UTC: `[start, end)`. Бюджеты источников считаются по их календарю, а он у всех UTC. */
export function monthWindow(now: number): { start: number; end: number } {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { start, end };
}

export interface IntervalInput {
  source: SourceDefinition;
  plan: SourcePlan;
  /** Сколько запросов к источнику уже сделано в этом месяце. */
  monthRequests: number;
  now: number;
  rules: PlannerRules;
}

/**
 * Интервал между опросами: не чаще природной частоты данных, не чаще лимита
 * в минуту и так, чтобы остатка месячного бюджета хватило до конца месяца.
 * Исчерпан — ждём нового месяца, а не получаем отказ.
 */
export function pollIntervalMs(input: IntervalInput): number {
  const { source, plan, monthRequests, now, rules } = input;
  let interval = Math.max(source.naturalIntervalMs, rules.minIntervalMs);

  if (plan.limits.requestsPerMinute !== null) {
    interval = Math.max(interval, Math.ceil(MINUTE_MS / plan.limits.requestsPerMinute));
  }
  if (plan.limits.requestsPerMonth !== null) {
    const { end } = monthWindow(now);
    const allowed = Math.floor(plan.limits.requestsPerMonth * (1 - rules.monthlyReserveRatio));
    const remaining = allowed - monthRequests;
    interval = Math.max(interval, remaining <= 0 ? end - now : Math.ceil((end - now) / remaining));
  }
  return interval;
}

export function initialSourceState(sourceId: string): SourceState {
  return { sourceId, pausedUntil: null, consecutiveRateLimits: 0, lastPolledAt: null, lastSucceededAt: null };
}

export function nextPollAt(state: SourceState, intervalMs: number): number {
  const byInterval = state.lastPolledAt === null ? 0 : state.lastPolledAt + intervalMs;
  return Math.max(byInterval, state.pausedUntil ?? 0);
}

export function isPaused(state: SourceState, now: number): boolean {
  return state.pausedUntil !== null && state.pausedUntil > now;
}

export function isDue(state: SourceState, intervalMs: number, now: number): boolean {
  return nextPollAt(state, intervalMs) <= now;
}

export function afterSuccess(state: SourceState, now: number): SourceState {
  return { ...state, consecutiveRateLimits: 0, pausedUntil: null, lastPolledAt: now, lastSucceededAt: now };
}

/** Обычная ошибка — не повод для паузы: следующий опрос по интервалу. */
export function afterFailure(state: SourceState, now: number): SourceState {
  return { ...state, lastPolledAt: now };
}

/** Отказ по лимиту — пауза этого источника, а не ошибка модуля: остальные продолжают. */
export function afterRateLimited(state: SourceState, now: number, rules: PlannerRules): SourceState {
  const attempts = state.consecutiveRateLimits + 1;
  const pause = Math.min(rules.rateLimitPauseMaxMs, rules.rateLimitPauseBaseMs * 2 ** (attempts - 1));
  return { ...state, consecutiveRateLimits: attempts, pausedUntil: now + pause, lastPolledAt: now };
}
