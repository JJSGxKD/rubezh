import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunOptions, RunSession } from "@bh/core-game";

// Рубеж в состоянии забега и в аналитике (tasks/T-0124): сообщения шины
// становятся баннером, итог несёт `rubezh` и `rubezhClearedSec` словаря
// событий, а итог на экране смерти не теряет поле `rubezh` при сохранении.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { recoverDownedRun, useRun } = await import("../src/state/run");
const { takeDownedRun, saveDownedRun } = await import("../src/state/downed-run");
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

function result(patch: Partial<RunResult> = {}): RunResult {
  return {
    runId: "run-1",
    seed: 42,
    outcome: "died",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "normal",
    contentHash: "abc",
    waveReached: 3,
    survivalSec: 700,
    level: 9,
    xpCollected: 300,
    enemiesKilled: 400,
    killsByEnemy: { swarm_rat: 400 },
    damageDealt: 5000,
    damageTaken: 200,
    damageByElement: {},
    noHitSec: 0,
    noKillSec: 0,
    killsByElement: {},
    bossKills: 1,
    eliteKills: 0,
    chestsOpened: 0,
    rareChestsOpened: 0,
    crystalsCollected: 0,
    weapons: [{ id: "spark", level: 4, damage: 5000 }],
    passives: [],
    deathCause: "swarm_rat",
    distance: 9000,
    peakEnemies: 80,
    cheats: false,
    continues: [],
    ...patch,
  };
}

let payloads: { event: string; payload: Record<string, unknown> }[] = [];

const OPTIONS = { container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" as const };

async function started(): Promise<ReturnType<typeof fakeEngine>> {
  const fake = fakeEngine();
  engine.load.mockResolvedValue(fake.engine);
  await useRun.getState().start(OPTIONS);
  return fake;
}

describe("рубеж в состоянии забега", () => {
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
    useRun.getState().stop();
  });

  it("до сообщений баннера нет", async () => {
    await started();
    expect(useRun.getState().rubezhNotice).toBeNull();
    useRun.getState().stop();
  });

  it("страж пришёл — сообщение «spawned»; страж пал — «cleared» с новым номером", async () => {
    const fake = await started();
    fake.emit("rubezhGuardSpawned", { enemyId: "rubezh_guard", elapsedSec: 600 });
    const first = useRun.getState().rubezhNotice;
    expect(first).toMatchObject({ kind: "spawned" });

    fake.emit("rubezhCleared", { clearedSec: 650, elapsedSec: 650 });
    const second = useRun.getState().rubezhNotice;
    expect(second).toMatchObject({ kind: "cleared" });
    // Номер меняется с каждым сообщением: по нему баннер отличает новое от повтора.
    expect(second?.seq).not.toBe(first?.seq);
    useRun.getState().stop();
  });

  it("баннер не порождает событий аналитики: других событий, кроме итога, нет", async () => {
    const fake = await started();
    const before = payloads.length;
    fake.emit("rubezhGuardSpawned", { enemyId: "rubezh_guard", elapsedSec: 600 });
    fake.emit("rubezhCleared", { clearedSec: 650, elapsedSec: 650 });
    expect(payloads).toHaveLength(before);
    useRun.getState().stop();
  });

  it("остановка забега снимает сообщение: новый забег начинается без баннера", async () => {
    const fake = await started();
    fake.emit("rubezhGuardSpawned", { enemyId: "rubezh_guard", elapsedSec: 600 });
    useRun.getState().stop();
    expect(useRun.getState().rubezhNotice).toBeNull();
  });
});

describe("рубеж в итоге забега", () => {
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
    useRun.getState().stop();
  });

  const payloadOf = (event: string): Record<string, unknown> => payloads.find((item) => item.event === event)?.payload ?? {};

  it("победа: run_finished несёт rubezh «cleared» и целую секунду победы", async () => {
    const fake = await started();
    fake.emit("finished", result({ rubezh: { reached: true, clearedSec: 702.4, guardHpPercent: null } }));
    expect(payloadOf("run_finished")).toMatchObject({ rubezh: "cleared", rubezhClearedSec: 702 });
    useRun.getState().stop();
  });

  it("страж пришёл, но жив: «reached» без секунды", async () => {
    const fake = await started();
    fake.emit("finished", result({ rubezh: { reached: true, clearedSec: null, guardHpPercent: 12 } }));
    const payload = payloadOf("run_finished");
    expect(payload).toMatchObject({ rubezh: "reached" });
    expect(payload).not.toHaveProperty("rubezhClearedSec");
    useRun.getState().stop();
  });

  it("не дошёл: «none»", async () => {
    const fake = await started();
    fake.emit("finished", result({ rubezh: { reached: false, clearedSec: null, guardHpPercent: null } }));
    expect(payloadOf("run_finished")).toMatchObject({ rubezh: "none" });
    useRun.getState().stop();
  });

  it("сдался: run_abandoned несёт те же поля", async () => {
    const fake = await started();
    fake.emit("abandoned", result({ outcome: "abandoned", rubezh: { reached: true, clearedSec: 640, guardHpPercent: null } }));
    expect(payloadOf("run_abandoned")).toMatchObject({ rubezh: "cleared", rubezhClearedSec: 640 });
    useRun.getState().stop();
  });

  it("итог без поля (сборка движка до рубежа) полей не добавляет", async () => {
    const fake = await started();
    fake.emit("finished", result());
    const payload = payloadOf("run_finished");
    expect(payload).not.toHaveProperty("rubezh");
    expect(payload).not.toHaveProperty("rubezhClearedSec");
    useRun.getState().stop();
  });
});

describe("итог на экране смерти хранит рубеж", () => {
  beforeEach(() => {
    payloads = [];
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
      storage: memoryStorage(),
      analytics: (event, payload) => payloads.push({ event, payload: payload ?? {} }),
      build: { version: "test", contentHash: "", platform: "web" },
    });
    useMeta.getState().hydrate();
  });

  it("сохранённый итог возвращается с rubezh, схема его не отбрасывает", () => {
    const rubezh = { reached: true, clearedSec: 700, guardHpPercent: null };
    saveDownedRun({ result: result({ rubezh }), countInRating: false });
    expect(takeDownedRun()?.result.rubezh).toEqual(rubezh);
  });

  it("итог без rubezh читается как раньше", () => {
    saveDownedRun({ result: result(), countInRating: false });
    expect(takeDownedRun()?.result.rubezh).toBeUndefined();
  });

  it("брошенный на экране смерти забег уходит в run_finished с rubezh", () => {
    saveDownedRun({ result: result({ rubezh: { reached: true, clearedSec: 700, guardHpPercent: null } }), countInRating: false });
    recoverDownedRun();
    const finished = payloads.find((item) => item.event === "run_finished");
    expect(finished?.payload).toMatchObject({ rubezh: "cleared", rubezhClearedSec: 700, recovered: true });
  });
});
