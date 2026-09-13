import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";
import type { HudSnapshot, RunEngine, RunEvents, RunSession } from "@bh/core-game";

// Этапы загрузки забега, замер до первого кадра и условия предзагрузки
// движка (docs/27-design-system-and-app-shell.md §3.4).

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { preloadRunEngine, useRun } = await import("../src/state/run");
const { initShell } = await import("../src/state/shell");

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

/** Сессия-заглушка: запоминает подписчиков, чтобы тест мог «прислать» событие движка. */
function fakeEngine(): { engine: RunEngine; emitHud(): void } {
  const handlers: Handlers = {};
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
    destroy: () => undefined,
  } as unknown as RunSession;

  return {
    engine: { start: () => session },
    emitHud: () => handlers.hud?.(HUD),
  };
}

const HUD: HudSnapshot = {
  survivalSec: 0,
  hp: 10,
  maxHp: 10,
  level: 1,
  xp: 0,
  xpToNext: 5,
  wave: 0,
  enemiesAlive: 0,
  enemiesKilled: 0,
  weapons: [],
  passives: [],
};

const events: { event: string; payload: Record<string, unknown> }[] = [];

function startOptions(): Parameters<ReturnType<typeof useRun.getState>["start"]>[0] {
  return { container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier" };
}

describe("загрузка забега", () => {
  beforeEach(() => {
    events.length = 0;
    engine.load.mockReset();
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
      storage: undefined,
      analytics: (event, payload) => events.push({ event, payload }),
      build: { version: "test", contentHash: "", platform: "web" },
    });
    useRun.getState().stop();
  });

  it("идёт этапами: чанк движка, затем мир до первого снимка HUD", async () => {
    const fake = fakeEngine();
    let resolveEngine: (value: RunEngine) => void = () => undefined;
    engine.load.mockReturnValue(new Promise<RunEngine>((resolve) => (resolveEngine = resolve)));

    const starting = useRun.getState().start(startOptions());
    expect(useRun.getState().loadingStage).toBe("engine");

    resolveEngine(fake.engine);
    await starting;
    expect(useRun.getState().loadingStage).toBe("world");

    fake.emitHud();
    expect(useRun.getState().loadingStage).toBeNull();
  });

  it("пишет время до первого кадра один раз — «Ещё раз» его не перезаписывает", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);

    await useRun.getState().start(startOptions());
    fake.emitHud();
    fake.emitHud();
    useRun.getState().restart();
    fake.emitHud();

    const frames = events.filter(
      ({ event, payload }) => event === "load_time" && payload.phase === "run_first_frame",
    );
    expect(frames).toHaveLength(1);
    expect(typeof frames[0]?.payload.ms).toBe("number");
    // Экран загрузки при перезапуске не показывается: сцена уже жива.
    expect(useRun.getState().loadingStage).toBeNull();
  });

  it("не оставляет экран загрузки поверх ошибки, если движок не пришёл", async () => {
    engine.load.mockRejectedValue(new Error("сеть"));
    await useRun.getState().start(startOptions());

    expect(useRun.getState().phase).toBe("error");
    expect(useRun.getState().loadingStage).toBeNull();
  });
});

describe("предзагрузка движка", () => {
  beforeEach(() => {
    engine.load.mockReset();
    vi.unstubAllGlobals();
  });

  // Модуль помнит, что предзагрузка уже шла, — порядок тестов важен и
  // повторяет жизнь приложения: сначала отказы, потом загрузка.
  it("не грузит при экономии трафика", () => {
    vi.stubGlobal("navigator", { onLine: true, connection: { saveData: true } });
    preloadRunEngine();
    expect(engine.load).not.toHaveBeenCalled();
  });

  it("не грузит без сети: неудачный импорт браузер может запомнить", () => {
    vi.stubGlobal("navigator", { onLine: false });
    preloadRunEngine();
    expect(engine.load).not.toHaveBeenCalled();
  });

  it("после неудачи пробует снова, а после удачи больше не грузит", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    engine.load.mockRejectedValueOnce(new Error("сеть"));
    preloadRunEngine();
    expect(engine.load).toHaveBeenCalledTimes(1);
    // Дать отработать обработчику отказа.
    await new Promise((resolve) => setTimeout(resolve, 0));

    engine.load.mockResolvedValue({ start: () => undefined });
    preloadRunEngine();
    expect(engine.load).toHaveBeenCalledTimes(2);

    // Лобби открывают много раз за сессию — чанк при этом один.
    preloadRunEngine();
    preloadRunEngine();
    expect(engine.load).toHaveBeenCalledTimes(2);
  });
});
