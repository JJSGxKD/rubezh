import { describe, expect, it } from "vitest";
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
} from "../src/rates/planner.js";
import { cbrSource, coingeckoSource, tonapiSource } from "../src/rates/sources/index.js";

// Планировщик (docs/35-stage4-plan.md §3.12, «Бюджет запросов»): не выходит
// за лимиты тарифа, к концу месяца опрашивает реже, а не получает отказ, на
// 429 ставит источник на паузу, ключ уплотняет расписание без правки кода.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** 1 сентября 2026, 00:00 UTC — начало месяца, чтобы бюджет считался от полного окна. */
const MONTH_START = Date.UTC(2026, 8, 1);

describe("тариф по ключу", () => {
  it("без ключа — бесплатный, с ключом — платный, ключ без платного тарифа не используется", () => {
    expect(resolvePlan(coingeckoSource, undefined)).toEqual({ plan: coingeckoSource.free, apiKey: undefined, paid: false });
    expect(resolvePlan(coingeckoSource, "")).toMatchObject({ paid: false });
    expect(resolvePlan(coingeckoSource, "key")).toEqual({ plan: coingeckoSource.paid, apiKey: "key", paid: true });
    expect(resolvePlan(cbrSource, "key")).toEqual({ plan: cbrSource.free, apiKey: undefined, paid: false });
  });

  it("появление ключа уплотняет опрос без правки кода", () => {
    const free = pollIntervalMs({ source: coingeckoSource, plan: resolvePlan(coingeckoSource, undefined).plan, monthRequests: 0, now: MONTH_START, rules: DEFAULT_PLANNER_RULES });
    const paid = pollIntervalMs({ source: coingeckoSource, plan: resolvePlan(coingeckoSource, "key").plan, monthRequests: 0, now: MONTH_START, rules: DEFAULT_PLANNER_RULES });
    expect(paid).toBeLessThan(free);
    expect(paid).toBe(DEFAULT_PLANNER_RULES.minIntervalMs);
  });
});

describe("интервал опроса", () => {
  it("не чаще природной частоты данных: ЦБ — раз в сутки", () => {
    expect(pollIntervalMs({ source: cbrSource, plan: cbrSource.free, monthRequests: 0, now: MONTH_START, rules: DEFAULT_PLANNER_RULES })).toBe(DAY);
  });

  it("растягивает месячный бюджет с запасом до конца месяца", () => {
    const interval = pollIntervalMs({ source: coingeckoSource, plan: coingeckoSource.free, monthRequests: 0, now: MONTH_START, rules: DEFAULT_PLANNER_RULES });
    const allowed = Math.floor(10_000 * 0.9);
    const monthMs = 30 * DAY;
    expect(interval).toBe(Math.ceil(monthMs / allowed));
    // За месяц по такому интервалу запросов меньше, чем позволяет бюджет с запасом.
    expect(Math.floor(monthMs / interval)).toBeLessThanOrEqual(allowed);
  });

  it("к концу месяца опрашивает реже, а исчерпав бюджет — ждёт нового месяца", () => {
    const lastDay = MONTH_START + 29 * DAY;
    const calm = pollIntervalMs({ source: coingeckoSource, plan: coingeckoSource.free, monthRequests: 100, now: lastDay, rules: DEFAULT_PLANNER_RULES });
    const spent = pollIntervalMs({ source: coingeckoSource, plan: coingeckoSource.free, monthRequests: 8_900, now: lastDay, rules: DEFAULT_PLANNER_RULES });
    const exhausted = pollIntervalMs({ source: coingeckoSource, plan: coingeckoSource.free, monthRequests: 9_000, now: lastDay, rules: DEFAULT_PLANNER_RULES });
    expect(spent).toBeGreaterThan(calm);
    expect(exhausted).toBe(DAY);
    expect(monthWindow(lastDay)).toEqual({ start: MONTH_START, end: MONTH_START + 30 * DAY });
  });

  it("лимит в минуту без месячного даёт интервал из него, но не ниже пола", () => {
    const interval = pollIntervalMs({ source: tonapiSource, plan: tonapiSource.free, monthRequests: 0, now: MONTH_START, rules: DEFAULT_PLANNER_RULES });
    expect(interval).toBe(MINUTE);
    const eager = { ...tonapiSource, naturalIntervalMs: 0 };
    const tight = pollIntervalMs({ source: eager, plan: tonapiSource.free, monthRequests: 0, now: MONTH_START, rules: { ...DEFAULT_PLANNER_RULES, minIntervalMs: 0 } });
    expect(tight).toBe(1000);
  });
});

describe("состояние источника", () => {
  it("новый источник опрашивается сразу, дальше — по интервалу", () => {
    const state = initialSourceState("cbr");
    expect(isDue(state, DAY, MONTH_START)).toBe(true);
    const polled = afterSuccess(state, MONTH_START);
    expect(polled).toMatchObject({ lastPolledAt: MONTH_START, lastSucceededAt: MONTH_START, pausedUntil: null, consecutiveRateLimits: 0 });
    expect(isDue(polled, DAY, MONTH_START + DAY - 1)).toBe(false);
    expect(isDue(polled, DAY, MONTH_START + DAY)).toBe(true);
    expect(nextPollAt(polled, DAY)).toBe(MONTH_START + DAY);
  });

  it("обычная ошибка не ставит на паузу, отказ по лимиту — ставит и удваивает до потолка", () => {
    const rules = DEFAULT_PLANNER_RULES;
    let state = afterFailure(initialSourceState("coingecko"), MONTH_START);
    expect(isPaused(state, MONTH_START)).toBe(false);
    expect(state.lastSucceededAt).toBeNull();

    state = afterRateLimited(state, MONTH_START, rules);
    expect(state.pausedUntil).toBe(MONTH_START + rules.rateLimitPauseBaseMs);
    expect(isPaused(state, MONTH_START + rules.rateLimitPauseBaseMs - 1)).toBe(true);
    expect(isPaused(state, MONTH_START + rules.rateLimitPauseBaseMs)).toBe(false);

    state = afterRateLimited(state, MONTH_START + 10 * MINUTE, rules);
    expect(state.pausedUntil).toBe(MONTH_START + 10 * MINUTE + 2 * rules.rateLimitPauseBaseMs);
    for (let i = 0; i < 10; i += 1) state = afterRateLimited(state, MONTH_START, rules);
    expect(state.pausedUntil).toBe(MONTH_START + rules.rateLimitPauseMaxMs);
    expect(state.consecutiveRateLimits).toBe(12);

    // Пауза важнее интервала: даже если по интервалу пора, до конца паузы — нет.
    expect(nextPollAt(state, MINUTE)).toBe(MONTH_START + rules.rateLimitPauseMaxMs);
    expect(afterSuccess(state, MONTH_START + DAY).consecutiveRateLimits).toBe(0);
  });
});
