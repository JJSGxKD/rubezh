import { describe, expect, it } from "vitest";
import { RunPerfTracker, type RunPerfContext } from "../src/game/diagnostics/run-perf";

const CONTEXT: RunPerfContext = {
  renderer: "webgl",
  renderCapFps: null,
  dpr: 2,
  canvasWidth: 780,
  canvasHeight: 1688,
  interruptions: 1,
};

function feed(tracker: RunPerfTracker, frameMs: number, count: number, objects = 0): void {
  for (let i = 0; i < count; i++) tracker.frame(frameMs, objects);
}

describe("сводка производительности забега", () => {
  it("не учитывает первые две секунды прогрева", () => {
    const tracker = new RunPerfTracker();
    feed(tracker, 100, 20); // две секунды фризов на старте
    feed(tracker, 1000 / 60, 600);
    const summary = tracker.summary(CONTEXT);
    expect(summary.frames).toBe(600);
    expect(summary.avgFps).toBeCloseTo(60, 5);
    expect(summary.over33Ratio).toBe(0);
  });

  it("считает p95 по гистограмме с точностью четверть миллисекунды", () => {
    const tracker = new RunPerfTracker();
    feed(tracker, 20, 100); // ровно две секунды прогрева
    feed(tracker, 16.6, 900);
    feed(tracker, 40, 100);
    const summary = tracker.summary(CONTEXT);
    // 1000 кадров, 10% долгих: 95-й перцентиль приходится на долгие кадры.
    expect(summary.p95FrameMs).toBeGreaterThanOrEqual(40);
    expect(summary.p95FrameMs).toBeLessThanOrEqual(40.25);
    expect(summary.frames).toBe(1000);
    expect(summary.over33Ratio).toBeCloseTo(0.1, 5);
  });

  it("кадр длиннее четверти секунды не ломает гистограмму", () => {
    const tracker = new RunPerfTracker();
    feed(tracker, 20, 100);
    feed(tracker, 900, 100);
    expect(tracker.summary(CONTEXT).p95FrameMs).toBe(250);
  });

  it("частоту экрана берёт из начала забега, пик объектов — за весь забег", () => {
    const tracker = new RunPerfTracker();
    feed(tracker, 1000 / 120, 400, 10);
    feed(tracker, 30, 100, 900);
    feed(tracker, 1000 / 120, 100, 50);
    const summary = tracker.summary(CONTEXT);
    expect(summary.displayHz).toBe(120);
    expect(summary.peakObjects).toBe(900);
    expect(summary).toMatchObject(CONTEXT);
  });

  it("пустой забег — нули, а не NaN", () => {
    const summary = new RunPerfTracker().summary(CONTEXT);
    expect([summary.avgFps, summary.p95FrameMs, summary.over33Ratio, summary.displayHz]).toEqual([0, 0, 0, 0]);
  });
});
