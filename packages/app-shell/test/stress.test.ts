import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";
import type { BenchProgress, BenchSubmission, StressEngine, StressEvents, StressOptions, StressSession } from "@bh/core-game";

// Стресс-тест из раздела «Играть» (docs/28-diagnostics.md §2.3).

const engine = vi.hoisted(() => ({ load: vi.fn() }));
const reports = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("../src/state/diagnostic-reports", () => ({ sendDiagnosticReport: reports.send }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadStressEngine: engine.load,
}));

const { useStress } = await import("../src/state/stress");
const { initShell } = await import("../src/state/shell");

type Handlers = { [E in keyof StressEvents]?: (payload: StressEvents[E]) => void };

function fakeEngine(): {
  engine: StressEngine;
  emit<E extends keyof StressEvents>(event: E, payload: StressEvents[E]): void;
  started: StressOptions[];
  destroyed: () => number;
  stopped: () => number;
} {
  const handlers: Handlers = {};
  const started: StressOptions[] = [];
  let destroyed = 0;
  let stopped = 0;
  const session: StressSession = {
    on(event, handler) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    stop: () => {
      stopped++;
    },
    destroy: () => {
      destroyed++;
    },
  };
  return {
    engine: {
      start: (options) => {
        started.push(options);
        return session;
      },
    },
    emit: (event, payload) => (handlers[event] as ((value: typeof payload) => void) | undefined)?.(payload),
    started,
    destroyed: () => destroyed,
    stopped: () => stopped,
  };
}

const PROGRESS: BenchProgress = {
  elapsedSec: 12,
  durationSec: 300,
  running: true,
  enemies: 400,
  projectiles: 150,
  gems: 90,
  objects: 640,
  targetEnemies: 420,
  fps: 58,
  p95FrameMs: 18,
  badWindows: 0,
  interruptions: 0,
};

const SUBMISSION = {
  reportId: "11111111-2222-4333-8444-555555555555",
  report: {
    startedAt: "2026-09-15T10:00:00.000Z",
    stoppedBy: "degradation",
    profile: { mode: "stress" },
    totals: { peakObjects: 1210.4 },
  },
  verdict: { level: "no-go", breakingPoint: null },
} as unknown as BenchSubmission;

const events: { event: string; payload: Record<string, unknown> }[] = [];
const uiCalls: string[] = [];

describe("стресс-тест в оболочке", () => {
  beforeEach(() => {
    events.length = 0;
    uiCalls.length = 0;
    engine.load.mockReset();
    reports.send.mockReset();
    // Тесты идут в Node: экрана и плотности там нет, а сведения об устройстве их читают.
    vi.stubGlobal("screen", { width: 412, height: 915 });
    vi.stubGlobal("devicePixelRatio", 2.63);
    const ui = {
      ...createNoopPlatformUi(),
      setVerticalSwipesEnabled: (enabled: boolean) => uiCalls.push(`swipes:${enabled}`),
      setClosingConfirmation: (enabled: boolean) => uiCalls.push(`confirm:${enabled}`),
    };
    initShell({
      adapter: {
        ui,
        haptic: () => undefined,
        clientInfo: () => ({ platform: "android", version: "8.0" }),
      } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
      storage: undefined,
      analytics: (event, payload) => events.push({ event, payload }),
      build: { version: "0.3.0", contentHash: "", platform: "web" },
    });
    useStress.getState().dispose();
    uiCalls.length = 0;
  });

  it("идёт на пределе устройства, без Telegram ID и строки браузера в отчёте", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);

    await useStress.getState().start({} as HTMLElement);
    expect(useStress.getState().phase).toBe("loading");
    expect(fake.started[0]).toMatchObject({ buildVersion: "0.3.0" });
    expect(fake.started[0]?.device).toMatchObject({ userAgent: "", telegramUserId: null, telegramPlatform: "android" });
    // На прогоне случайный свайп не сворачивает приложение.
    expect(uiCalls).toEqual(["swipes:false", "confirm:true"]);

    fake.emit("progress", PROGRESS);
    expect(useStress.getState()).toMatchObject({ phase: "running", progress: PROGRESS });
  });

  it("по итогу отправляет отчёт в приёмник диагностики и пишет событие из словаря", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    reports.send.mockResolvedValue(null);

    await useStress.getState().start({} as HTMLElement);
    fake.emit("finished", SUBMISSION);
    await vi.waitFor(() => expect(useStress.getState().sendState).toBe("sent"));

    expect(reports.send).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: SUBMISSION.reportId,
        kind: "bench",
        appVersion: "0.3.0",
        occurredAt: "2026-09-15T10:00:00.000Z",
        device: expect.objectContaining({ os: expect.any(String), screenWidth: 412 }),
        payload: SUBMISSION,
      }),
    );
    expect(useStress.getState().phase).toBe("finished");
    expect(events).toContainEqual({
      event: "bench_finished",
      payload: { mode: "stress", stopReason: "degradation", peakObjects: 1210, verdict: "no-go", reportId: SUBMISSION.reportId },
    });
  });

  it("неудачную отправку можно повторить, а выключенную — нет смысла", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    reports.send.mockResolvedValueOnce("offline").mockResolvedValueOnce(null);

    await useStress.getState().start({} as HTMLElement);
    fake.emit("finished", SUBMISSION);
    await vi.waitFor(() => expect(useStress.getState().sendState).toBe("failed"));
    await useStress.getState().send();
    expect(useStress.getState().sendState).toBe("sent");

    reports.send.mockResolvedValueOnce("forbidden");
    useStress.setState({ sendState: "idle" });
    await useStress.getState().send();
    expect(useStress.getState().sendState).toBe("disabled");
  });

  it("уход с экрана во время загрузки чанка не создаёт движок", async () => {
    const fake = fakeEngine();
    let resolve: (value: StressEngine) => void = () => undefined;
    engine.load.mockReturnValue(new Promise<StressEngine>((done) => (resolve = done)));

    const starting = useStress.getState().start({} as HTMLElement);
    useStress.getState().dispose();
    resolve(fake.engine);
    await starting;

    expect(fake.started).toHaveLength(0);
    expect(useStress.getState().phase).toBe("idle");
  });

  it("остановка и уход с экрана доходят до движка", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);

    await useStress.getState().start({} as HTMLElement);
    useStress.getState().stop();
    expect(fake.stopped()).toBe(1);
    useStress.getState().dispose();
    expect(fake.destroyed()).toBe(1);
    expect(uiCalls.at(-2)).toBe("swipes:true");
  });
});
