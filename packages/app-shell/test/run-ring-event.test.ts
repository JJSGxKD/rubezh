import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunOptions, RunSession } from "@bh/core-game";

// Исход кольца стражей в оболочке (tasks/T-0182): сообщение движка `ringEnded`
// превращается ровно в одно событие аналитики `ring_ended`, секунды — целые.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { useRun } = await import("../src/state/run");
const { useMeta } = await import("../src/state/meta");
const { useSavedRun } = await import("../src/state/run-save");
const { initShell } = await import("../src/state/shell");

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

function fakeEngine() {
  const handlers: Handlers = {};
  const emit = <E extends keyof RunEvents>(event: E, payload: RunEvents[E]): void =>
    (handlers[event] as ((value: typeof payload) => void) | undefined)?.(payload);
  const session = {
    on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    abandon: () => undefined,
    snapshot: () => null,
    destroy: () => undefined,
  } as unknown as RunSession;
  const fake: RunEngine = { start: (_options: RunOptions) => session };
  return { engine: fake, emit };
}

function memoryStorage(): KeyValueStorage {
  const values: Record<string, string> = {};
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

let payloads: { event: string; payload: Record<string, unknown> }[] = [];

const OPTIONS = { container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" as const };

describe("событие ring_ended", () => {
  beforeEach(() => {
    engine.load.mockReset();
    payloads = [];
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
      storage: memoryStorage(),
      analytics: (event, payload) => payloads.push({ event, payload: payload ?? {} }),
      build: { version: "test", contentHash: "", platform: "web" },
    });
    useMeta.getState().hydrate();
    useSavedRun.getState().hydrate();
  });

  it("одно сообщение — одно событие с теми же полями, секунды округлены", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(OPTIONS);

    fake.emit("ringEnded", { index: 1, outcome: "held", guards: 40, killed: 12, lifeSec: 44.6, elapsedSec: 210.4 });

    const sent = payloads.filter((item) => item.event === "ring_ended");
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({ index: 1, outcome: "held", guards: 40, killed: 12, lifeSec: 45, elapsedSec: 210 });
    useRun.getState().stop();
  });

  it("два кольца — два события, исход не теряется", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(OPTIONS);

    fake.emit("ringEnded", { index: 0, outcome: "broken", guards: 24, killed: 24, lifeSec: 12, elapsedSec: 100 });
    fake.emit("ringEnded", { index: 1, outcome: "died", guards: 24, killed: 3, lifeSec: 20, elapsedSec: 200 });

    expect(payloads.filter((item) => item.event === "ring_ended").map((item) => item.payload.outcome)).toEqual(["broken", "died"]);
    useRun.getState().stop();
  });
});
