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

// Потолок ключей payload на сервере (`MAX_PAYLOAD_KEYS` в словаре событий):
// оболочка не импортирует бэкенд, поэтому число продублировано, а равенство
// не меньше 48 держит scripts/test/event-dictionary.test.ts.
const MAX_PAYLOAD_KEYS = 48;

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

const RESULT = {
  survivalSec: 100.4,
  seed: 42,
  outcome: "died",
  cheats: false,
  continues: [] as number[],
  damageByElement: { physical: 1200.4, fire: 310.6 },
} as RunResult;

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

  it("кладёт урон по стихиям в run_finished целыми и с нулями", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" });

    fake.emit("diagnostics", DIAGNOSTICS);
    fake.emit("finished", RESULT);

    const finished = events.find((entry) => entry.event === "run_finished");
    expect(finished?.payload).toMatchObject({
      damagePhysical: 1200,
      damageFire: 311,
      damageCold: 0,
      damageLightning: 0,
      damagePoison: 0,
    });
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

  describe("сила и давление (tasks/T-0196, решение 5)", () => {
    const START = { runId: "run-1", difficultyId: "hard" as const, startingWeaponId: "spark" };
    const PRESSURE = { power: 2.01, level: 1, deviceClass: "standard" as const };
    const PRESSURE_RESULT = { ...PRESSURE, powerEnd: 2.4, levelEnd: 1.04 };

    async function started() {
      const fake = fakeEngine();
      engine.load.mockResolvedValue(fake.engine);
      await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" });
      return fake;
    }
    const startedEvents = () => events.filter((entry) => entry.event === "run_started");

    it("run_started уходит из события started, один раз, с силой и прежними полями", async () => {
      const fake = await started();
      expect(startedEvents()).toHaveLength(0);

      fake.emit("started", { ...START, pressure: PRESSURE });

      expect(startedEvents()).toHaveLength(1);
      expect(startedEvents()[0]?.payload).toMatchObject({
        power: 2.01,
        pressure: 1,
        deviceClass: "standard",
        weapon: "spark",
        map: "frontier",
        difficulty: "hard",
        devMode: false,
      });
      expect(startedEvents()[0]?.payload).toEqual(
        expect.objectContaining({ seed: expect.any(Number), screenMode: expect.any(String), orientation: expect.any(String) }),
      );
    });

    it("started без давления — run_started без новых полей", async () => {
      const fake = await started();
      fake.emit("started", START);

      const payload = startedEvents()[0]?.payload ?? {};
      expect(payload).not.toHaveProperty("power");
      expect(payload).not.toHaveProperty("pressure");
      expect(payload).not.toHaveProperty("deviceClass");
      expect(payload).toMatchObject({ weapon: "spark", difficulty: "hard" });
    });

    it("«Ещё раз» — второе started — отправляет событие второй раз", async () => {
      const fake = await started();
      fake.emit("started", { ...START, pressure: PRESSURE });
      fake.emit("finished", RESULT);
      fake.emit("started", { ...START, runId: "run-2", pressure: { ...PRESSURE, power: 3.1 } });

      expect(startedEvents()).toHaveLength(2);
      expect(startedEvents()[1]?.payload).toMatchObject({ power: 3.1 });
    });

    it("итог с давлением несёт силу и давление на старте и в конце, итог без него — нет", async () => {
      const fake = await started();
      fake.emit("finished", { ...RESULT, pressure: PRESSURE_RESULT });
      fake.emit("abandoned", { ...RESULT, outcome: "abandoned" });

      const finished = events.find((entry) => entry.event === "run_finished");
      expect(finished?.payload).toMatchObject({ power: 2.01, pressure: 1, powerEnd: 2.4, pressureEnd: 1.04, deviceClass: "standard" });
      const abandoned = events.find((entry) => entry.event === "run_abandoned");
      for (const key of ["power", "pressure", "powerEnd", "pressureEnd", "deviceClass"]) expect(abandoned?.payload, key).not.toHaveProperty(key);
    });

    it("самый полный payload итога не длиннее лимита словаря за вычетом запаса", async () => {
      const fake = await started();
      fake.emit("diagnostics", DIAGNOSTICS);
      fake.emit("finished", { ...RESULT, pressure: PRESSURE_RESULT });

      const payload = events.find((entry) => entry.event === "run_finished")?.payload ?? {};
      // Поля, которые приходят не из этого пути: чёрный арт, восстановленный забег, прерванный обновлением.
      const others = ["art", "recovered", "interrupted"].filter((key) => !(key in payload)).length;
      expect(Object.keys(payload).length + others).toBeLessThanOrEqual(MAX_PAYLOAD_KEYS - 4);
    });
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
