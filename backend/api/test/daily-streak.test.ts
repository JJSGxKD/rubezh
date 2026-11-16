import { describe, expect, it } from "vitest";
import { dailyReward } from "../src/modules/daily/daily-rules.js";
import { STREAK_MAX, STREAK_MISS_PENALTY, STREAK_STEP, currentStreak, nextStreak, streakMul, streakView } from "../src/modules/daily/daily-streak.js";
import { DailyService } from "../src/modules/daily/daily.service.js";
import type { ProgressService } from "../src/modules/progress/progress.service.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import { MemoryDaily } from "./helpers/memory-daily.js";

/**
 * Серия дней (tasks/T-0262, docs/35-stage4-plan.md Р154): каждый день подряд
 * +5 % к награде дня, до +50 % на десятый; пропущенный день снимает две
 * ступени за каждые сутки пропуска, но серию не обнуляет.
 */

const ME = "00000000-0000-4000-8000-00000000d262";
const HOUR = 3_600_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const dayAfter = (days: number) => new Date(NOON.getTime() + days * 24 * HOUR);

describe("константы серии", () => {
  it("+5 % за ступень, потолок десять, пропуск — две ступени", () => {
    expect(STREAK_STEP).toBe(0.05);
    expect(STREAK_MAX).toBe(10);
    expect(STREAK_MISS_PENALTY).toBe(2);
  });
});

describe("ступень серии при заборе", () => {
  it("первый забор — первая ступень, подряд — растёт на одну", () => {
    expect(nextStreak(0, null, "2026-09-30")).toBe(1);
    expect(nextStreak(0, "2026-09-29", "2026-09-30")).toBe(1);
    expect(nextStreak(1, "2026-09-29", "2026-09-30")).toBe(2);
  });

  it("на потолке остаётся потолком", () => {
    expect(nextStreak(10, "2026-09-29", "2026-09-30")).toBe(10);
    expect(nextStreak(9, "2026-09-29", "2026-09-30")).toBe(10);
  });

  it("пропуск одного дня снимает две ступени, но забор даёт одну: с 7 — на 6, с 1 — на 1", () => {
    expect(nextStreak(7, "2026-09-28", "2026-09-30")).toBe(6);
    expect(nextStreak(1, "2026-09-28", "2026-09-30")).toBe(1);
  });

  it("пропуск нескольких дней: с 10 за три дня — 5, за десять — 1, ниже единицы не падает", () => {
    expect(nextStreak(10, "2026-09-26", "2026-09-30")).toBe(5);
    expect(nextStreak(10, "2026-09-19", "2026-09-30")).toBe(1);
    expect(nextStreak(3, "2026-01-01", "2026-09-30")).toBe(1);
  });

  it("граница месяца и года считается календарём, а не вычитанием строк", () => {
    expect(nextStreak(4, "2026-09-30", "2026-10-01")).toBe(5);
    expect(nextStreak(4, "2026-12-31", "2027-01-01")).toBe(5);
    expect(nextStreak(4, "2026-12-30", "2027-01-01")).toBe(3);
  });

  it("повтор в те же сутки ступень не меняет", () => {
    expect(nextStreak(5, "2026-09-30", "2026-09-30")).toBe(5);
  });
});

describe("ступень серии сейчас, до забора", () => {
  it("вчерашний забор серию не трогает, пропуск — снимает по две ступени за день", () => {
    expect(currentStreak(5, "2026-09-29", "2026-09-30")).toBe(5);
    expect(currentStreak(5, "2026-09-30", "2026-09-30")).toBe(5);
    expect(currentStreak(5, "2026-09-28", "2026-09-30")).toBe(3);
    expect(currentStreak(5, "2026-09-20", "2026-09-30")).toBe(0);
    expect(currentStreak(0, null, "2026-09-30")).toBe(0);
  });
});

describe("множитель серии", () => {
  it("ноль ступеней — единица, десять — полторы, больше потолка не растёт", () => {
    expect(streakMul(0)).toBe(1);
    expect(streakMul(3)).toBeCloseTo(1.15, 10);
    expect(streakMul(10)).toBe(1.5);
    expect(streakMul(25)).toBe(1.5);
    expect(streakMul(-4)).toBe(1);
  });

  it("ответ серии: ступень, процент и ступень после следующего забора", () => {
    expect(streakView(0, null, "2026-09-30", false)).toEqual({ days: 0, bonusPercent: 0, next: 1 });
    // Забрано сегодня: «next» — ступень после завтрашнего забора.
    expect(streakView(3, "2026-09-30", "2026-09-30", true)).toEqual({ days: 3, bonusPercent: 15, next: 4 });
    expect(streakView(10, "2026-09-30", "2026-09-30", true)).toEqual({ days: 10, bonusPercent: 50, next: 10 });
    // Не забрано, пропущен день: показана уже сниженная ступень, next — что даст сегодняшний забор.
    expect(streakView(7, "2026-09-28", "2026-09-30", false)).toEqual({ days: 5, bonusPercent: 25, next: 6 });
  });
});

describe("награда дня с серией", () => {
  it("множитель идёт в то же округление, что и формула дня", () => {
    expect(dailyReward(3, 1, undefined, 3)).toEqual({ coins: 115, shards: 0 });
    expect(dailyReward(3, 1)).toEqual({ coins: 100, shards: 0 });
    expect(dailyReward(7, 1, undefined, 10)).toEqual({ coins: 450, shards: 15 });
    // Самый щедрый день с полной серией и двойной — под суточным потолком причины.
    const richest = dailyReward(35, 100, undefined, 10);
    expect(richest.coins * 2).toBeLessThan(5_000);
    expect(richest.shards * 2).toBeLessThan(100);
  });
});

class FakeWallet {
  readonly keys = new Map<string, number>();

  async grant(input: GrantInput): Promise<GrantResult> {
    const duplicate = this.keys.has(input.idempotencyKey);
    if (!duplicate) this.keys.set(input.idempotencyKey, input.amount);
    return { credited: duplicate ? 0 : input.amount, balance: 0, duplicate };
  }
}

function setup(level = 1) {
  const repository = new MemoryDaily();
  const wallet = new FakeWallet();
  const progress = { view: async () => ({ level }) } as unknown as ProgressService;
  const service = new DailyService(repository, progress, wallet as unknown as WalletService);
  return { repository, wallet, service };
}

describe("забор награды дня и серия", () => {
  it("три дня подряд: ступени 1, 2, 3 — награда третьего дня ×1,15", async () => {
    const s = setup();
    const first = await s.service.claim(ME, NOON);
    expect(first).toMatchObject({ coins: 63 });
    expect(first.view.streak).toEqual({ days: 1, bonusPercent: 5, next: 2 });
    await s.service.claim(ME, dayAfter(1));
    const third = await s.service.claim(ME, dayAfter(2));
    expect(third.coins).toBe(115);
    expect(third.view.streak).toEqual({ days: 3, bonusPercent: 15, next: 4 });
    expect(s.repository.streak).toBe(3);
  });

  it("пропуск дня — две ступени долой, без обнуления", async () => {
    const s = setup();
    for (let day = 0; day < 5; day++) await s.service.claim(ME, dayAfter(day));
    expect(s.repository.streak).toBe(5);
    // День 5 пропущен, забор на шестые сутки: 5 − 2 + 1 = 4.
    const after = await s.service.claim(ME, dayAfter(6));
    expect(after.view.streak.days).toBe(4);
    expect(after.coins).toBe(dailyReward(6, 1, undefined, 4).coins);
  });

  it("пропуск двух и более дней, с серии в одну ступень — всё равно ступень один", async () => {
    const s = setup();
    await s.service.claim(ME, NOON);
    const after = await s.service.claim(ME, dayAfter(5));
    expect(after.view.streak.days).toBe(1);
  });

  it("на десятый день +50 %, дальше потолок", async () => {
    const s = setup();
    for (let day = 0; day < 12; day++) await s.service.claim(ME, dayAfter(day));
    expect(s.repository.streak).toBe(10);
    const view = await s.service.view(ME, dayAfter(11));
    expect(view.streak).toEqual({ days: 10, bonusPercent: 50, next: 10 });
  });

  it("повторный забор в те же сутки не начисляет и серию не двигает", async () => {
    const s = setup();
    await s.service.claim(ME, NOON);
    const again = await s.service.claim(ME, new Date(NOON.getTime() + HOUR));
    expect(again).toMatchObject({ claimed: false, coins: 0 });
    expect(again.view.streak).toEqual({ days: 1, bonusPercent: 5, next: 2 });
    expect(s.repository.streak).toBe(1);
  });

  it("параллельные заборы — серия растёт один раз", async () => {
    const s = setup();
    await Promise.all([s.service.claim(ME, NOON), s.service.claim(ME, NOON), s.service.claim(ME, NOON)]);
    expect(s.repository.streak).toBe(1);
  });
});
