import type { DailyRepository, DailyState } from "../../src/modules/daily/daily.repository.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Московские сутки без перехода на летнее время: UTC+3. */
export function moscowDay(time: Date): number {
  return Math.floor((time.getTime() + 3 * HOUR) / DAY);
}

/** Номер суток в виде `ГГГГ-ММ-ДД`, как отдаёт база. */
export function dayText(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

/** Награда дня в памяти: сколько дней забрано, в какие сутки и на какой ступени серии. */
export class MemoryDaily implements DailyRepository {
  claimedDays = 0;
  lastDay: number | null = null;
  streak = 0;

  /** забрать день `claimedDays + 1` в сутки `time`; ступень серии — `streak` */
  claim(time: Date, streak = 0): void {
    this.claimedDays++;
    this.lastDay = moscowDay(time);
    this.streak = streak;
  }

  async state(_accountId: string, time: Date): Promise<DailyState> {
    return {
      claimedDays: this.claimedDays,
      claimedToday: this.lastDay === moscowDay(time),
      streak: this.streak,
      lastClaimDay: this.lastDay === null ? null : dayText(this.lastDay),
      today: dayText(moscowDay(time)),
    };
  }

  async advance(_accountId: string, expected: number, time: Date, streak: number): Promise<boolean> {
    if (this.claimedDays !== expected || this.lastDay === moscowDay(time)) return false;
    this.claim(time, streak);
    return true;
  }
}
