import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunDevOptions, RunEngine, RunEvents, RunOptions, RunSession } from "@bh/core-game";

// Режим разработчика в оболочке: настройки, забег разработчика и учёт в
// рейтинге (docs/26-stage2-plan.md, WP14).

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { DEFAULT_DEV_SETTINGS, hasCheats, toRunDev, useDevMode } = await import("../src/state/dev-mode");
const { DEV_PRESETS } = await import("../src/screens/run/dev-presets");
const { useRun } = await import("../src/state/run");
const { useMeta } = await import("../src/state/meta");
const { toSubmission, useRuns } = await import("../src/state/runs");
const { initShell } = await import("../src/state/shell");

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

const chosen: string[] = [];

function fakeEngine(): { engine: RunEngine; started: RunOptions[]; setDev: RunDevOptions[]; emit: Handlers } {
  const handlers: Handlers = {};
  const started: RunOptions[] = [];
  const setDev: RunDevOptions[] = [];
  const session = {
    on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    setDev: (options: RunDevOptions) => setDev.push(options),
    devCommand: () => undefined,
    chooseUpgrade: (optionId: string) => chosen.push(optionId),
    snapshot: () => null,
    destroy: () => undefined,
    pause: () => undefined,
  } as unknown as RunSession;
  return {
    engine: {
      start: (options) => {
        started.push(options);
        return session;
      },
    },
    started,
    setDev,
    emit: handlers,
  };
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

function result(patch: Partial<RunResult> = {}): RunResult {
  return {
    runId: "run-dev-1",
    seed: 1,
    outcome: "died",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "normal",
    contentHash: "hash",
    waveReached: 2,
    survivalSec: 900,
    level: 30,
    xpCollected: 0,
    enemiesKilled: 10,
    killsByEnemy: {},
    damageDealt: 0,
    damageTaken: 0,
    damageByElement: {},
    weapons: [],
    passives: [],
    deathCause: null,
    distance: 0,
    peakEnemies: 0,
    cheats: true,
    continues: [],
    ...patch,
  };
}

function start(devTools: boolean): void {
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, devTools },
    storage: memoryStorage(),
    analytics: () => undefined,
    build: { version: "test", contentHash: "", platform: "web" },
  });
  useMeta.getState().hydrate();
  useDevMode.getState().hydrate();
}

const RUN = { container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" as const };

describe("настройки режима разработчика", () => {
  beforeEach(() => start(true));

  it("переживают перезапуск приложения", () => {
    useDevMode.getState().update((settings) => ({ ...settings, timeScale: 0.5 }));
    useDevMode.setState({ settings: DEFAULT_DEV_SETTINGS });
    useDevMode.getState().hydrate();
    expect(useDevMode.getState().settings.timeScale).toBe(0.5);
  });

  it("набор заменяет настройки целиком, а не добавляет к ним", () => {
    useDevMode.getState().update(() => DEV_PRESETS.telegraphs);
    expect(useDevMode.getState().settings.timeScale).toBe(0.5);
    useDevMode.getState().update(() => DEV_PRESETS.clean);
    expect(useDevMode.getState().settings).toEqual(DEFAULT_DEV_SETTINGS);
    expect(hasCheats(DEFAULT_DEV_SETTINGS)).toBe(false);
    expect(hasCheats(DEV_PRESETS.arsenal)).toBe(true);
  });

  it("превращает старт в команды движку", () => {
    const dev = toRunDev(DEV_PRESETS.lateGame);
    expect(dev.start.filter((command) => command.kind === "giveWeapon").length).toBeGreaterThan(1);
    expect(dev.start.at(-1)).toEqual({ kind: "jumpToMinute", minute: 10 });
    expect(toRunDev(DEFAULT_DEV_SETTINGS).start).toEqual([]);
  });
});

describe("забег разработчика", () => {
  beforeEach(() => {
    engine.load.mockReset();
    useRun.getState().stop();
  });

  it("идёт только взведённым и только у того, кому открыт режим", async () => {
    start(false);
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);

    useDevMode.getState().arm(true);
    await useRun.getState().start(RUN);
    expect(fake.started[0]?.dev).toBeUndefined();
    expect(useRun.getState().devRun).toBe(false);
    useRun.getState().stop();

    start(true);
    useDevMode.getState().arm(false);
    await useRun.getState().start(RUN);
    expect(fake.started[1]?.dev).toBeUndefined();
    useRun.getState().stop();

    useDevMode.getState().arm(true);
    await useRun.getState().start(RUN);
    expect(fake.started[2]?.dev).toMatchObject({ timeScale: 1, start: [] });
    expect(useRun.getState().devRun).toBe(true);
  });

  it("настройки с паузы уходят в движок сразу", async () => {
    start(true);
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    useDevMode.getState().arm(true);
    await useRun.getState().start(RUN);

    useDevMode.getState().update((settings) => ({ ...settings, cheats: { ...settings.cheats, godMode: true } }));
    expect(fake.setDev.at(-1)?.cheats.godMode).toBe(true);

    // После остановки забега настройки движок уже не трогают.
    useRun.getState().stop();
    const calls = fake.setDev.length;
    useDevMode.getState().update((settings) => ({ ...settings, timeScale: 2 }));
    expect(fake.setDev).toHaveLength(calls);
  });

  it("берёт первое улучшение сам, если так настроено, и только в забеге разработчика", async () => {
    start(true);
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    chosen.length = 0;
    const offer = { level: 4, queued: 0, options: [{ id: "heal", kind: "heal", refId: "heal", level: 1, changes: [] }] } as unknown as RunEvents["levelUp"];

    useDevMode.getState().update((settings) => ({ ...settings, autoPickUpgrades: true }));
    useDevMode.getState().arm(true);
    await useRun.getState().start(RUN);
    fake.emit.levelUp?.(offer);
    expect(chosen).toEqual(["heal"]);
    expect(useRun.getState().phase).not.toBe("levelUp");
    useRun.getState().stop();

    useDevMode.getState().arm(false);
    await useRun.getState().start(RUN);
    fake.emit.levelUp?.(offer);
    expect(chosen).toEqual(["heal"]);
    expect(useRun.getState().phase).toBe("levelUp");
  });

  it("забег с читами не двигает рекорд, пока не попросили учесть", async () => {
    start(true);
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    const submitRun = vi.spyOn(useRuns.getState(), "submitRun").mockImplementation(() => undefined);
    useDevMode.getState().arm(true);
    await useRun.getState().start(RUN);

    fake.emit.finished?.(result());
    expect(useRun.getState().isNewRecord).toBe(false);
    expect(useMeta.getState().best.normal).toBe(0);
    expect(submitRun).toHaveBeenLastCalledWith(expect.objectContaining({ cheats: true }), false);

    useRun.getState().stop();
    useDevMode.getState().update((settings) => ({ ...settings, countInRating: true }));
    await useRun.getState().start(RUN);
    fake.emit.finished?.(result({ runId: "run-dev-2" }));
    expect(useMeta.getState().best.normal).toBe(900);
    expect(submitRun).toHaveBeenLastCalledWith(expect.objectContaining({ runId: "run-dev-2" }), true);
    submitRun.mockRestore();
  });
});

describe("итог с читами для сервера", () => {
  it("несёт пометку и просьбу учесть, а честный забег — ни того ни другого", () => {
    expect(toSubmission(result(), true)).toMatchObject({ cheats: true, countInRating: true });
    const honest = toSubmission(result({ cheats: false }), true);
    expect(honest).not.toHaveProperty("cheats");
    expect(honest).not.toHaveProperty("countInRating");
  });
});
