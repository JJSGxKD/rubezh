import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoopPlatformUi,
  type KeyValueStorage,
  type PlatformAdapter,
  type RunResult,
} from "@bh/shared-types";
import {
  CONTENT_HASH,
  RUN_SNAPSHOT_FORMAT,
  type RunEngine,
  type RunEvents,
  type RunOptions,
  type RunSession,
  type RunSnapshot,
} from "@bh/core-game";

// Сохранение прерванного забега (docs/27-design-system-and-app-shell.md §7):
// когда пишется, когда удаляется и что считается непродолжаемым.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { useRun } = await import("../src/state/run");
const { useSavedRun } = await import("../src/state/run-save");
const { initShell } = await import("../src/state/shell");

const SAVE_KEY = "bh.run.v1.save";

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

function snapshot(patch: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    format: RUN_SNAPSHOT_FORMAT,
    contentHash: CONTENT_HASH,
    runId: "run-1",
    seed: 42,
    mapId: "frontier",
    difficultyId: "hard",
    startingWeaponId: "knife",
    summary: { survivalSec: 95, level: 6, weapons: [{ id: "knife", level: 2 }], passives: [] },
    world: { version: 1 },
    ...patch,
  };
}

function fakeEngine(taken: RunSnapshot | null = snapshot()): {
  engine: RunEngine;
  emit<E extends keyof RunEvents>(event: E, payload: RunEvents[E]): void;
  started: RunOptions[];
} {
  const handlers: Handlers = {};
  const started: RunOptions[] = [];
  const session = {
    on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    chooseUpgrade: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    abandon: () => undefined,
    restart: () => undefined,
    snapshot: () => taken,
    destroy: () => undefined,
  } as unknown as RunSession;

  return {
    engine: {
      start: (options) => {
        started.push(options);
        return session;
      },
    },
    emit: (event, payload) => (handlers[event] as ((value: typeof payload) => void) | undefined)?.(payload),
    started,
  };
}

function memoryStorage(): KeyValueStorage & { values: Record<string, string> } {
  const values: Record<string, string> = {};
  return {
    values,
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

let storage = memoryStorage();

function options(resume?: RunSnapshot): Parameters<ReturnType<typeof useRun.getState>["start"]>[0] {
  return {
    container: {} as HTMLElement,
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "normal",
    ...(resume === undefined ? {} : { resume }),
  };
}

/** Вход на экран забега: то, что знает сам экран, без намерения игрока. */
function entry(): Parameters<ReturnType<typeof useRun.getState>["enter"]>[0] {
  return {
    container: {} as HTMLElement,
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "normal",
  };
}

describe("сохранение прерванного забега", () => {
  beforeEach(() => {
    engine.load.mockReset();
    storage = memoryStorage();
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
      storage,
      analytics: () => undefined,
      build: { version: "test", contentHash: "", platform: "web" },
    });
    useRun.getState().stop();
    useSavedRun.getState().hydrate();
  });

  it("сохраняется на паузе и переживает перезапуск приложения", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(options());

    fake.emit("paused", { reason: "app_inactive", elapsedSec: 95 });
    expect(storage.values[SAVE_KEY]).toBeDefined();

    // «Перезапуск»: стор читает хранилище заново.
    useSavedRun.setState({ saved: null });
    useSavedRun.getState().hydrate();
    expect(useSavedRun.getState().saved?.summary.level).toBe(6);
  });

  it("удаляется, когда забег кончился: продолжать нечего", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(options());
    fake.emit("paused", { reason: "manual", elapsedSec: 95 });

    fake.emit("finished", { survivalSec: 100, seed: 42, continues: [] as number[] } as RunResult);
    expect(useSavedRun.getState().saved).toBeNull();
    useSavedRun.getState().hydrate();
    expect(useSavedRun.getState().saved).toBeNull();
  });

  it("сохраняется при уходе с экрана посреди забега", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(options());

    useRun.getState().stop();
    expect(useSavedRun.getState().saved?.runId).toBe("run-1");
  });

  it("не предлагает продолжить забег, снятый на другой версии контента или формата", () => {
    storage.set(SAVE_KEY, JSON.stringify({ ...snapshot({ contentHash: "old" }), savedAt: 1 }));
    useSavedRun.getState().hydrate();
    expect(useSavedRun.getState().saved).toBeNull();

    storage.set(SAVE_KEY, JSON.stringify({ ...snapshot({ format: RUN_SNAPSHOT_FORMAT + 1 }), savedAt: 1 }));
    useSavedRun.getState().hydrate();
    expect(useSavedRun.getState().saved).toBeNull();
  });

  it("новый забег занимает место сохранения, продолженный — нет", async () => {
    useSavedRun.getState().save(snapshot());
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);

    await useRun.getState().start(options(snapshot()));
    expect(fake.started[0]?.resume?.runId).toBe("run-1");
    expect(useSavedRun.getState().saved).not.toBeNull();

    useRun.getState().stop();
    await useRun.getState().start(options());
    expect(useSavedRun.getState().saved).toBeNull();
  });

  it("отложенное продолжение не теряется, если экран запустили дважды", async () => {
    // Режим разработки React монтирует экран, размонтирует и монтирует снова.
    const fake = fakeEngine();
    let resolve: (value: RunEngine) => void = () => undefined;
    engine.load.mockReturnValueOnce(new Promise<RunEngine>((done) => (resolve = done)));
    engine.load.mockResolvedValue(fake.engine);

    useRun.getState().intend({ kind: "resume", snapshot: snapshot() });
    const first = useRun.getState().enter(entry());
    useRun.getState().stop();
    expect(useRun.getState().intent).not.toBeNull();

    await useRun.getState().enter(entry());
    resolve(fake.engine);
    await first;

    expect(fake.started).toHaveLength(1);
    expect(fake.started[0]?.resume?.runId).toBe("run-1");
    expect(useRun.getState().intent).toBeNull();
  });

  it("помнит, что забег был забегом разработчика, и после перезапуска приложения", () => {
    // Признак режима хранится в снимке, а не во взведённом флаге стора: флаг
    // живёт до перезапуска, а продолжают забег и через сутки.
    useSavedRun.getState().save(snapshot({ dev: true, cheats: true }));

    useSavedRun.setState({ saved: null });
    useSavedRun.getState().hydrate();

    expect(useSavedRun.getState().saved?.dev).toBe(true);
    expect(useSavedRun.getState().saved?.cheats).toBe(true);
  });

  it("вход на экран без намерения продолжает сохранение, а не стирает его", async () => {
    // Так экран забега монтируется заново после сворачивания: игрок ничего не
    // выбирал, и начинать новый забег поверх четырнадцати минут нельзя.
    useSavedRun.getState().save(snapshot());
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);

    await useRun.getState().enter(entry());

    expect(fake.started[0]?.resume?.runId).toBe("run-1");
    expect(useSavedRun.getState().saved).not.toBeNull();
  });

  it("явный новый забег сохранение занимает: игрок бросил прежний сам", async () => {
    useSavedRun.getState().save(snapshot());
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);

    useRun.getState().intend({ kind: "new" });
    await useRun.getState().enter(entry());

    expect(fake.started[0]?.resume).toBeUndefined();
    expect(useSavedRun.getState().saved).toBeNull();
  });

  it("битое сохранение, которое движок не смог прочитать, удаляется", async () => {
    useSavedRun.getState().save(snapshot());
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(options(snapshot()));

    fake.emit("error", { message: "Снимок забега не читается" });
    expect(useRun.getState().errorMessage).toBe("error.resume");
    expect(useSavedRun.getState().saved).toBeNull();
  });
});
