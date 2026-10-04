import { describe, expect, it } from "vitest";
import { dailyReward, dayPosition, levelMul, stepMul } from "../src/modules/daily/daily-rules.js";
import type { DailyRepository, DailyState } from "../src/modules/daily/daily.repository.js";
import { DailyService, viewOf } from "../src/modules/daily/daily.service.js";
import type { ProgressService } from "../src/modules/progress/progress.service.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";

/**
 * Награда дня (docs/35-stage4-plan.md Р45, WP13): пропуск дня не сбрасывает
 * прогресс, ступень растёт по закрытым неделям до потолка, день забирается
 * один раз в московские сутки — и два запроса разом начисляют его однажды.
 */

const ME = "00000000-0000-4000-8000-00000000d001";
const HOUR = 3_600_000;
/** 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));

/** Московские сутки без перехода на летнее время: UTC+3. */
function moscowDay(at: Date): number {
  return Math.floor((at.getTime() + 3 * HOUR) / (24 * HOUR));
}

class MemoryDaily implements DailyRepository {
  row: { claimedDays: number; lastDay: number } | null = null;

  async state(_accountId: string, at: Date): Promise<DailyState> {
    return { claimedDays: this.row?.claimedDays ?? 0, claimedToday: this.row?.lastDay === moscowDay(at) };
  }

  async advance(_accountId: string, expected: number, at: Date): Promise<boolean> {
    const current = this.row?.claimedDays ?? 0;
    if (current !== expected || (this.row !== null && this.row.lastDay >= moscowDay(at))) return false;
    this.row = { claimedDays: current + 1, lastDay: moscowDay(at) };
    return true;
  }
}

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

describe("числа награды дня", () => {
  it("день недели — по порядку забора, ступень — закрытые недели до потолка", () => {
    expect(dayPosition(1)).toEqual({ dayOfWeek: 0, closedWeeks: 0 });
    expect(dayPosition(7)).toEqual({ dayOfWeek: 6, closedWeeks: 0 });
    expect(dayPosition(8)).toEqual({ dayOfWeek: 0, closedWeeks: 1 });
    expect(stepMul(0)).toBe(1);
    expect(stepMul(4)).toBe(1.6);
    expect(stepMul(40)).toBe(1.6);
  });

  it("первая неделя — около тысячи монет, седьмой день крупнее и с осколками", () => {
    const week = Array.from({ length: 7 }, (_, index) => dailyReward(index + 1, 1));
    expect(week.reduce((sum, day) => sum + day.coins, 0)).toBe(990);
    expect(week[6]).toEqual({ coins: 300, shards: 10 });
    expect(week.slice(0, 6).every((day) => day.shards === 0)).toBe(true);
  });

  it("уровень растит монеты, но не осколки; ступень растит и то и другое", () => {
    expect(levelMul(1)).toBe(1);
    expect(levelMul(21)).toBeCloseTo(1.4);
    expect(dailyReward(7, 21)).toEqual({ coins: 420, shards: 10 });
    expect(dailyReward(14, 1)).toEqual({ coins: 345, shards: 12 });
  });

  it("самый щедрый день далеко под суточным потолком кошелька", () => {
    const richest = dailyReward(35, 100);
    expect(richest.coins).toBeLessThan(5_000);
    expect(richest.shards).toBeLessThan(100);
  });
});

describe("неделя на экране", () => {
  it("новичок: первый день сегодня, ничего не забрано", () => {
    const view = viewOf(0, false, 1);
    expect(view.week).toBe(1);
    expect(view.canClaim).toBe(true);
    expect(view.days.map((day) => [day.day, day.claimed, day.today])[0]).toEqual([1, false, true]);
  });

  it("забрал седьмой день — до новых суток видна закрытая неделя, а не пустая новая", () => {
    const closed = viewOf(7, true, 1);
    expect(closed.week).toBe(1);
    expect(closed.days.every((day) => day.claimed)).toBe(true);
    expect(closed.days[6]?.today).toBe(true);

    const next = viewOf(7, false, 1);
    expect(next.week).toBe(2);
    expect(next.days[0]).toMatchObject({ day: 8, claimed: false, today: true, coins: 69 });
    expect(next.step).toBe(1.15);
  });

  it("награда завтрашнего дня — следующая по порядку; за седьмым — первый день новой недели со своей ступенью", () => {
    expect(viewOf(0, false, 1).next).toEqual({ coins: 80, shards: 0 });
    expect(viewOf(1, true, 1).next).toEqual({ coins: 80, shards: 0 });
    // Сегодня забран шестой — завтра седьмой, крупный и с осколками.
    expect(viewOf(6, true, 1).next).toEqual({ coins: 300, shards: 10 });
    expect(viewOf(7, true, 1).next).toEqual({ coins: 69, shards: 0 });
    // Уровень растит монеты завтрашнего дня так же, как сегодняшнего.
    expect(viewOf(1, true, 11).next.coins).toBe(Math.round(80 * 1.2));
  });
});

describe("забор награды дня", () => {
  it("день забирается один раз в московские сутки, а новые сутки — с полуночи по Москве", async () => {
    const s = setup();
    expect(await s.service.claim(ME, NOON)).toMatchObject({ claimed: true, coins: 60, shards: 0 });
    expect(await s.service.claim(ME, new Date(NOON.getTime() + 11 * HOUR))).toMatchObject({ claimed: false, coins: 0 });

    // 21:00 UTC — полночь по Москве: следующий день.
    const midnight = new Date(Date.UTC(2026, 8, 30, 21));
    expect(await s.service.claim(ME, midnight)).toMatchObject({ claimed: true, coins: 80 });
  });

  it("пропуск дней не сбрасывает прогресс: после недели отсутствия — следующий день, а не первый", async () => {
    const s = setup();
    await s.service.claim(ME, NOON);
    await s.service.claim(ME, new Date(NOON.getTime() + 24 * HOUR));
    const later = await s.service.claim(ME, new Date(NOON.getTime() + 9 * 24 * HOUR));
    expect(later).toMatchObject({ claimed: true, coins: 100 });
    expect(later.view.days[2]).toMatchObject({ day: 3, claimed: true, today: true });
  });

  it("седьмой день кладёт и монеты, и осколки — разными ключами", async () => {
    const s = setup();
    for (let day = 0; day < 6; day++) await s.service.claim(ME, new Date(NOON.getTime() + day * 24 * HOUR));
    const seventh = await s.service.claim(ME, new Date(NOON.getTime() + 6 * 24 * HOUR));
    expect(seventh).toMatchObject({ claimed: true, coins: 300, shards: 10 });
    expect([...s.wallet.keys.keys()].filter((key) => key.includes(":7"))).toEqual([`daily_reward:${ME}:7`, `daily_reward:${ME}:7:shards`]);
  });

  it("два запроса разом начисляют день однажды", async () => {
    const s = setup();
    const results = await Promise.all([s.service.claim(ME, NOON), s.service.claim(ME, NOON), s.service.claim(ME, NOON)]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.reduce((sum, result) => sum + result.coins, 0)).toBe(60);
    expect(s.repository.row?.claimedDays).toBe(1);
  });

  it("начислено, но не отмечено после сбоя — повтор узнаёт день по ключу и не начисляет дважды", async () => {
    const s = setup();
    await s.wallet.grant({ accountId: ME, resource: "coins", amount: 60, reason: "daily_reward", idempotencyKey: `daily_reward:${ME}:1` });
    const retry = await s.service.claim(ME, NOON);
    expect(retry).toMatchObject({ claimed: true, coins: 0 });
    expect(s.repository.row?.claimedDays).toBe(1);
  });

  it("уровень аккаунта увеличивает монеты дня", async () => {
    const s = setup(51);
    expect(await s.service.claim(ME, NOON)).toMatchObject({ coins: 120 });
  });
});

describe("знак награды дня", () => {
  it("горит, пока награда этих суток не забрана, и гаснет после забора", async () => {
    const s = setup();
    expect(await s.service.badge(ME, NOON)).toBe(1);
    await s.service.claim(ME, NOON);
    expect(await s.service.badge(ME, NOON)).toBe(0);
    expect(await s.service.badge(ME, new Date(Date.UTC(2026, 8, 30, 21)))).toBe(1);
  });
});
