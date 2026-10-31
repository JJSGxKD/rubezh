import { describe, expect, it } from "vitest";
import { barFill, leftToNext, markers, readyIn, type PointsBar } from "../src/screens/meta/task-points-rules";

// Полоса очков дня и недели (docs/39-retention-mechanics.md П2, tasks/T-0105):
// доля заполнения, «до награды ещё N очков», число готовых ступеней и позиции
// ступеней на полосе — чистые правила, без экрана.

const reward = (coins: number) => ({ coins, gems: 0, shards: 0 });
const bar = (total: number, states: ("locked" | "ready" | "claimed")[], thresholds = [20, 50, 100]): PointsBar => ({
  total,
  steps: thresholds.map((points, index) => ({ points, reward: reward(points), state: states[index] ?? "locked" })),
});
const STEPS = bar(0, []).steps;

describe("заполнение полосы", () => {
  it("пустая — 0; на первом пороге — 0,2; между порогами — по очкам; на последнем — 1", () => {
    expect(barFill(0, STEPS)).toBe(0);
    expect(barFill(20, STEPS)).toBeCloseTo(0.2, 10);
    expect(barFill(35, STEPS)).toBeCloseTo(0.35, 10);
    expect(barFill(50, STEPS)).toBeCloseTo(0.5, 10);
    expect(barFill(100, STEPS)).toBe(1);
  });

  it("за последним порогом — не больше 1; меньше нуля — 0; без ступеней — 0, а не деление на ноль", () => {
    expect(barFill(250, STEPS)).toBe(1);
    expect(barFill(-10, STEPS)).toBe(0);
    expect(barFill(40, [])).toBe(0);
  });
});

describe("до следующей награды", () => {
  it("до ближайшей закрытой ступени: с нуля — до первой, между — до следующей", () => {
    expect(leftToNext(bar(0, []))).toBe(20);
    expect(leftToNext(bar(5, []))).toBe(15);
    expect(leftToNext(bar(20, ["ready"]))).toBe(30);
    expect(leftToNext(bar(60, ["claimed", "ready"]))).toBe(40);
  });

  it("все ступени пройдены (готовы или забраны) — null: говорить «ещё N» нечего", () => {
    expect(leftToNext(bar(100, ["ready", "ready", "ready"]))).toBeNull();
    expect(leftToNext(bar(100, ["claimed", "claimed", "claimed"]))).toBeNull();
    expect(leftToNext(bar(100, ["claimed", "ready", "claimed"]))).toBeNull();
    expect(leftToNext({ total: 0, steps: [] })).toBeNull();
  });

  it("очков на пороге не хватает — читается как нужное число, а не как ноль", () => {
    expect(leftToNext(bar(19, []))).toBe(1);
  });
});

describe("готовые ступени", () => {
  it("readyIn считает только готовые к забору: закрытые и забранные не входят", () => {
    expect(readyIn(bar(0, []))).toBe(0);
    expect(readyIn(bar(60, ["claimed", "ready", "locked"]))).toBe(1);
    expect(readyIn(bar(100, ["ready", "ready", "ready"]))).toBe(3);
    expect(readyIn(bar(100, ["claimed", "claimed", "claimed"]))).toBe(0);
    expect(readyIn({ total: 0, steps: [] })).toBe(0);
  });
});

describe("позиции ступеней на полосе", () => {
  it("доли по самой дальней ступени: последняя — на правом краю", () => {
    expect(markers(STEPS)).toEqual([0.2, 0.5, 1]);
    expect(markers(bar(0, [], [150, 400, 700]).steps).map((value) => Math.round(value * 1000) / 1000)).toEqual([0.214, 0.571, 1]);
  });

  it("одна ступень — на краю; без ступеней — пусто", () => {
    expect(markers(bar(0, [], [20]).steps)).toEqual([1]);
    expect(markers([])).toEqual([]);
  });
});
