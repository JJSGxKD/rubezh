import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunDiagnostics, RunEngine, RunEvents, RunRecording, RunSession } from "@bh/core-game";

// Итог забега в аналитике: сводка производительности плоскими полями
// (docs/28-diagnostics.md §3.2).

const engine = vi.hoisted(() => ({ load: vi.fn() }));
const reports = vi.hoisted(() => ({ queueRunReport: vi.fn() }));

vi.mock("../src/state/run-report", () => ({ queueRunReport: reports.queueRunReport }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { useRun } = await import("../src/state/run");
const { initShell, reportError } = await import("../src/state/shell");

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

function fakeEngine(): { engine: RunEngine; emit<E extends keyof RunEvents>(event: E, payload: RunEvents[E]): void } {
  const handlers: Handlers = {};
  const session = {
    on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    snapshot: () => null,
    destroy: () => undefined,
  } as unknown as RunSession;
  return {
    engine: { start: () => session },
    emit: (event, payload) => (handlers[event] as ((value: typeof payload) => void) | undefined)?.(payload),
  };
}

const RESULT = { survivalSec: 100.4, seed: 42, outcome: "died", cheats: false } as RunResult;

const DIAGNOSTICS: RunDiagnostics = {
  perf: {
    frames: 5400,
    durationSec: 90.1,
    avgFps: 59.93,
    p95FrameMs: 17.25,
    over33Ratio: 0.01234,
    peakObjects: 812,
    displayHz: 60,
    renderCapFps: null,
    renderer: "webgl",
    dpr: 2.625,
    canvasWidth: 1080,
    canvasHeight: 2340,
    interruptions: 0,
  },
  recording: null,
};

describe("итог забега в аналитике", () => {
  let events: { event: string; payload: Record<string, unknown> }[] = [];

  beforeEach(() => {
    engine.load.mockReset();
    reports.queueRunReport.mockReset();
    events = [];
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
      storage: undefined,
      analytics: (event, payload) => events.push({ event, payload }),
      build: { version: "test", contentHash: "", platform: "web" },
    });
    useRun.getState().stop();
  });

  it("кладёт сводку производительности в run_finished плоскими полями", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" });

    fake.emit("diagnostics", DIAGNOSTICS);
    fake.emit("finished", RESULT);

    const finished = events.find((entry) => entry.event === "run_finished");
    expect(finished?.payload).toMatchObject({
      perfFrames: 5400,
      perfAvgFps: 59.9,
      perfP95FrameMs: 17.25,
      perfOver33Ratio: 0.0123,
      perfPeakObjects: 812,
      perfRenderCapFps: null,
      perfRenderer: "webgl",
      perfDpr: 2.63,
    });
    expect(Object.values(finished?.payload ?? {}).every((value) => typeof value !== "object" || value === null)).toBe(true);
  });

  it("без технического итога шлёт итог как раньше, и чужая сводка к следующему забегу не прилипает", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" });

    fake.emit("diagnostics", DIAGNOSTICS);
    fake.emit("finished", RESULT);
    fake.emit("abandoned", { ...RESULT, outcome: "abandoned" });

    const abandoned = events.find((entry) => entry.event === "run_abandoned");
    expect(abandoned?.payload).not.toHaveProperty("perfAvgFps");
  });

  it("запись забега уходит в очередь отчётов вместе с числом ошибок за забег", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    reportError("before", "ошибка до забега не его");
    await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" });
    reportError("render", "текстура не загрузилась");

    const recording = { reportId: "7f1c2b4e-0000-4000-8000-000000000000" } as RunRecording;
    fake.emit("diagnostics", { ...DIAGNOSTICS, recording });
    fake.emit("finished", RESULT);
    await vi.waitFor(() => expect(reports.queueRunReport).toHaveBeenCalledTimes(1));

    expect(reports.queueRunReport).toHaveBeenCalledWith(recording, 1);
  });

  it("без записи очередь отчётов не трогается", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" });
    fake.emit("diagnostics", DIAGNOSTICS);
    fake.emit("finished", RESULT);
    await Promise.resolve();
    expect(reports.queueRunReport).not.toHaveBeenCalled();
  });
});
