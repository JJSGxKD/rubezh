import { describe, expect, it } from "vitest";
import { shouldTally, TALLY_MAX_TICKS, TALLY_MIN_GAP_MS, tallyTicks } from "../src/app/balance-tally";
import { COUNT_UP_MS, countUpValue } from "../src/screens/count-up-rules";

// Счёт баланса в шапке (design/art/direction-v2.md §7.6): после награды
// число в шапке набегает с тихим счётом монет, а не меняется сразу.

describe("когда шапка считает", () => {
  it("только когда баланс вырос", () => {
    expect(shouldTally(100, 150)).toBe(true);
    expect(shouldTally(150, 100)).toBe(false);
    expect(shouldTally(150, 150)).toBe(false);
  });

  it("первая загрузка кошелька — не начисление: число встаёт сразу", () => {
    expect(shouldTally(null, 500)).toBe(false);
  });
});

describe("щелчки счёта", () => {
  it("по одному на монету, пока монет мало", () => {
    expect(tallyTicks(10, 13)).toHaveLength(3);
  });

  it("при большой награде — не больше потолка, сколько бы ни пришло", () => {
    const ticks = tallyTicks(0, 5000);
    expect(ticks.length).toBeGreaterThan(3);
    expect(ticks.length).toBeLessThanOrEqual(TALLY_MAX_TICKS);
  });

  it("идут по порядку, внутри счёта и не чаще порога", () => {
    let last = -Infinity;
    for (const tick of tallyTicks(0, 500)) {
      expect(tick.atMs).toBeGreaterThan(last);
      expect(tick.atMs).toBeLessThanOrEqual(COUNT_UP_MS);
      expect(tick.atMs - last).toBeGreaterThanOrEqual(TALLY_MIN_GAP_MS);
      last = tick.atMs;
    }
  });

  it("последний щелчок — ровно на итоге: звук и число кончаются вместе", () => {
    const ticks = tallyTicks(0, 500);
    expect(ticks.at(-1)?.atMs).toBe(COUNT_UP_MS);
    expect(countUpValue(0, 500, ticks.at(-1)?.atMs ?? 0)).toBe(500);
  });

  it("в такт торможению числа: к концу щелчки редеют", () => {
    const ticks = tallyTicks(0, 500);
    const gaps = ticks.slice(1).map((tick, i) => tick.atMs - (ticks[i]?.atMs ?? 0));
    expect(gaps.at(-1) ?? 0).toBeGreaterThan(gaps[0] ?? Infinity);
  });

  it("тон растёт к концу — кошель наполняется", () => {
    const ticks = tallyTicks(0, 500);
    expect(ticks[0]?.rate).toBeGreaterThanOrEqual(1);
    for (const [i, tick] of ticks.entries()) {
      if (i > 0) expect(tick.rate).toBeGreaterThan(ticks[i - 1]?.rate ?? Infinity);
    }
  });

  it("без роста щелчков нет", () => {
    expect(tallyTicks(100, 100)).toEqual([]);
    expect(tallyTicks(100, 40)).toEqual([]);
  });
});
