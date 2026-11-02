import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunSession } from "@bh/core-game";

// «Ещё раз» после обучающего забега (T-0190, Р126): «Ещё раз» бывает только
// после забега, значит первого забега уже нет, и следующий идёт на единой
// сложности — и в движке, и в аналитике.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../src/state/run-report", () => ({ queueRunReport: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { useRun } = await import("../src/state/run");
const { initShell } = await import("../src/state/shell");

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

function fakeEngine(): {
  engine: RunEngine;
  restart: ReturnType<typeof vi.fn>;
  declineContinue: ReturnType<typeof vi.fn>;
  emit<E extends keyof RunEvents>(event: E, payload: RunEvents[E]): void;
} {
  const handlers: Handlers = {};
  const restart = vi.fn();
  const declineContinue = vi.fn();
  const session = {
    on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    snapshot: () => null,
    destroy: () => undefined,
    restart,
    declineContinue,
  } as unknown as RunSession;
  return {
    engine: { start: () => session },
    restart,
    declineContinue,
    emit: (event, payload) => (handlers[event] as ((value: typeof payload) => void) | undefined)?.(payload),
  };
}

const RESULT = {
  survivalSec: 100.4,
  seed: 42,
  outcome: "died",
  difficultyId: "easy",
  cheats: false,
  continues: [] as number[],
  damageByElement: {},
} as unknown as RunResult;

describe("«Ещё раз» и сложность", () => {
  let events: { event: string; payload: Record<string, unknown> }[] = [];

  beforeEach(() => {
    engine.load.mockReset();
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

  async function startTutorial(): Promise<ReturnType<typeof fakeEngine>> {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "easy" });
    return fake;
  }

  it("после обучающего забега движок перезапускается на единой сложности", async () => {
    const fake = await startTutorial();
    fake.emit("finished", RESULT);

    useRun.getState().restart();

    expect(fake.restart).toHaveBeenCalledTimes(1);
    expect(fake.restart).toHaveBeenCalledWith(expect.any(Number), { difficultyId: "hard" });
  });

  it("run_started нового забега несёт hard, а не easy", async () => {
    const fake = await startTutorial();
    expect(events.find((entry) => entry.event === "run_started")?.payload).toMatchObject({ difficulty: "easy" });
    fake.emit("finished", RESULT);
    events.length = 0;

    useRun.getState().restart();

    expect(events.find((entry) => entry.event === "run_started")?.payload).toMatchObject({ difficulty: "hard" });
  });

  it("из фазы «downed» — то же: отказ от второго шанса и единая сложность", async () => {
    const fake = await startTutorial();
    fake.emit("downed", { result: RESULT, continuesLeft: 1 });
    expect(useRun.getState().phase).toBe("downed");
    events.length = 0;

    useRun.getState().restart();

    expect(fake.declineContinue).toHaveBeenCalledTimes(1);
    expect(fake.restart).toHaveBeenCalledWith(expect.any(Number), { difficultyId: "hard" });
    expect(events.find((entry) => entry.event === "run_started")?.payload).toMatchObject({ difficulty: "hard" });
  });

  it("второй «Ещё раз» подряд тоже идёт на единой сложности", async () => {
    const fake = await startTutorial();
    fake.emit("finished", RESULT);
    useRun.getState().restart();
    fake.emit("finished", { ...RESULT, difficultyId: "hard" });
    useRun.getState().restart();

    expect(fake.restart).toHaveBeenCalledTimes(2);
    expect(fake.restart).toHaveBeenLastCalledWith(expect.any(Number), { difficultyId: "hard" });
  });
});
