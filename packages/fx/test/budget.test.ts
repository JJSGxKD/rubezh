import { describe, expect, it } from "vitest";
import { RATE_LIMIT_PAUSE_MS, monthOf, nextPollDelayMs, pauseAfterRateLimit, recordPoll, type SourceUsage, type Tariff } from "../src/budget.js";

/**
 * Бюджет запросов (docs/35-stage4-plan.md, WP9, Р35): бесплатный тариф не
 * исчерпывается раньше конца месяца, `429` — пауза источника. Выбор тарифа
 * по ключу — в тестах адаптеров.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TARIFFS: Record<"free", Tariff> = {
  free: { name: "demo", perMinute: 30, perMonth: 10_000, minIntervalMs: MINUTE },
};

const fresh = (month: string): SourceUsage => ({ month, used: 0, pausedUntil: null });

describe("бюджет запросов", () => {
  it("месячный лимит растягивается на месяц, а не выбирается за неделю", () => {
    const start = new Date("2026-09-01T00:00:00Z");
    // 30 дней на 10 000 запросов — опрос раз в 4.32 минуты, чаще минутного минимума
    expect(nextPollDelayMs(TARIFFS.free, fresh("2026-09"), start)).toBe(Math.ceil((30 * DAY) / 10_000));
  });

  it("за месяц опроса по подсказке планировщика бюджет не превышается", () => {
    let now = new Date("2026-09-01T00:00:00Z");
    let usage = fresh("2026-09");
    let polls = 0;
    while (monthOf(now) === "2026-09") {
      usage = recordPoll(usage, now);
      polls++;
      now = new Date(now.getTime() + nextPollDelayMs(TARIFFS.free, usage, now));
    }
    expect(polls).toBeLessThanOrEqual(10_000);
    expect(polls).toBeGreaterThan(9_900);
  });

  it("выбрали лишнее в начале — к концу месяца опрос реже сам", () => {
    const late = new Date("2026-09-25T00:00:00Z");
    const normal = nextPollDelayMs(TARIFFS.free, { month: "2026-09", used: 8_333, pausedUntil: null }, late);
    const greedy = nextPollDelayMs(TARIFFS.free, { month: "2026-09", used: 9_900, pausedUntil: null }, late);
    expect(greedy).toBeGreaterThan(normal * 10);
  });

  it("бюджет кончился — ждём нового месяца, а не отказа", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(nextPollDelayMs(TARIFFS.free, { month: "2026-09", used: 10_000, pausedUntil: null }, now)).toBe(12 * HOUR);
  });

  it("с новым месяцем счётчик начинается заново", () => {
    const october = new Date("2026-10-01T00:00:00Z");
    expect(recordPoll({ month: "2026-09", used: 10_000, pausedUntil: null }, october)).toEqual({ month: "2026-10", used: 1, pausedUntil: null });
    expect(nextPollDelayMs(TARIFFS.free, { month: "2026-09", used: 10_000, pausedUntil: null }, october)).toBeLessThan(5 * MINUTE);
  });

  it("опрос не чаще лимита в минуту и минимума источника", () => {
    const tight = { name: "t", perMinute: 2, perMonth: null, minIntervalMs: 0 };
    expect(nextPollDelayMs(tight, fresh("2026-09"), new Date("2026-09-01T00:00:00Z"), 3)).toBe(90_000);
    const daily = { name: "d", perMinute: 60, perMonth: null, minIntervalMs: DAY };
    expect(nextPollDelayMs(daily, fresh("2026-09"), new Date("2026-09-01T00:00:00Z"))).toBe(DAY);
  });

  it("после 429 источник на паузе: не короче умолчания и не короче Retry-After", () => {
    const now = new Date("2026-09-10T00:00:00Z");
    const short = pauseAfterRateLimit(fresh("2026-09"), now, 30_000);
    const long = pauseAfterRateLimit(fresh("2026-09"), now, 2 * HOUR);
    expect(nextPollDelayMs(TARIFFS.free, short, now)).toBe(RATE_LIMIT_PAUSE_MS);
    expect(nextPollDelayMs(TARIFFS.free, long, now)).toBe(2 * HOUR);
    // успешный опрос снимает паузу
    expect(recordPoll(long, new Date(now.getTime() + 2 * HOUR)).pausedUntil).toBeNull();
  });
});
