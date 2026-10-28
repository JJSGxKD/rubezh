import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunOptions, RunSession } from "@bh/core-game";

// Второй шанс в оболочке (docs/07-monetization-and-ads.md §8): забег на экране
// смерти ждёт решения. Проверяется то, где это обычно ломается: забег,
// записанный дважды, забег, потерянный при закрытии приложения на экране
// смерти, и «сохранение», из которого игрок вернулся бы живым.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { recoverDownedRun, useRun } = await import("../src/state/run");
const { useMeta } = await import("../src/state/meta");
const { useSavedRun } = await import("../src/state/run-save");
const { initShell } = await import("../src/state/shell");
const { closeOffer, expectOffers } = await import("../src/state/second-chance-offers");
const { continueOfferedPayload, visibleWays, wayOrder } = await import("../src/screens/run/SecondChance");

const DOWNED_KEY = "bh.run.v1.downed";
const SAVE_KEY = "bh.run.v1.save";

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
    survivalSec: 250,
    level: 9,
    xpCollected: 300,
    enemiesKilled: 400,
    killsByEnemy: { swarm_rat: 400 },
    damageDealt: 5000,
    damageTaken: 200,
    damageByElement: {},
    bossKills: 0,
    eliteKills: 0,
    chestsOpened: 0,
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

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

/** Движок-заглушка: отказ от второго шанса закрывает забег сразу, как сцена. */
function fakeEngine() {
  const handlers: Handlers = {};
  const started: RunOptions[] = [];
  const emit = <E extends keyof RunEvents>(event: E, payload: RunEvents[E]): void =>
    (handlers[event] as ((value: typeof payload) => void) | undefined)?.(payload);
  const calls: string[] = [];
  let final = result();
  const session = {
    on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    continueRun: (options?: { cheat?: boolean }) => calls.push(options?.cheat === true ? "continue:cheat" : "continue"),
    declineContinue: () => {
      calls.push("decline");
      emit("finished", final);
    },
    restart: () => calls.push("restart"),
    abandon: () => undefined,
    snapshot: () => null,
    destroy: () => undefined,
  } as unknown as RunSession;
  const fake: RunEngine = {
    start: (options) => {
      started.push(options);
      return session;
    },
  };
  return { engine: fake, emit, calls, started, setFinal: (value: RunResult) => (final = value) };
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
let events: string[] = [];
let payloads: { event: string; payload: Record<string, unknown> }[] = [];

const OPTIONS = { container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" as const };

async function downed(): Promise<ReturnType<typeof fakeEngine>> {
  const fake = fakeEngine();
  engine.load.mockResolvedValue(fake.engine);
  await useRun.getState().start(OPTIONS);
  fake.emit("downed", { result: result(), continuesLeft: 1 });
  return fake;
}

describe("экран смерти со вторым шансом", () => {
  // Забег теста закрывается после него самого: уход с экрана смерти
  // записывает забег, и записать он должен в хранилище этого теста.
  afterEach(() => useRun.getState().stop());

  beforeEach(() => {
    engine.load.mockReset();
    storage = memoryStorage();
    events = [];
    payloads = [];
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
      storage,
      analytics: (event, payload) => {
        events.push(event);
        payloads.push({ event, payload: payload ?? {} });
      },
      build: { version: "test", contentHash: "", platform: "web" },
    });
    useMeta.getState().hydrate();
    useSavedRun.getState().hydrate();
  });

  it("не записывает забег, пока игрок решает, но держит его итог на устройстве", async () => {
    await downed();

    expect(useRun.getState().phase).toBe("downed");
    expect(useMeta.getState().runs).toBe(0);
    expect(events).not.toContain("run_finished");
    expect(JSON.parse(storage.values[DOWNED_KEY] ?? "null")).toMatchObject({ result: { runId: "run-1" } });
  });

  it("снимает сохранение сразу: из него игрок вернулся бы живым", async () => {
    storage.set(SAVE_KEY, "{}");
    await downed();

    expect(useSavedRun.getState().saved).toBeNull();
  });

  it("продолжение — команда движку, а записан будет только итог продолженного забега", async () => {
    const fake = await downed();
    useRun.getState().continueRun("premium");
    fake.emit("revived", { elapsedSec: 250, continuesUsed: 1 });

    expect(fake.calls).toEqual(["continue"]);
    expect(useRun.getState().phase).toBe("running");
    expect(storage.values[DOWNED_KEY]).toBe("null");
    expect(events).toContain("continue_used");

    fake.emit("finished", result({ survivalSec: 600, continues: [250] }));
    expect(useMeta.getState().runs).toBe(1);
    expect(useMeta.getState().best.normal).toBe(600);
  });

  it("бесплатное продолжение — только в забеге разработчика и с пометкой чита", async () => {
    const player = await downed();
    useRun.getState().continueRun("dev");
    expect(player.calls).toEqual([]);
    useRun.getState().stop();

    const dev = await downed();
    useRun.setState({ devRun: true });
    useRun.getState().continueRun("dev");
    dev.emit("revived", { elapsedSec: 250, continuesUsed: 1 });

    expect(dev.calls).toEqual(["continue:cheat"]);
    expect(payloads.find((entry) => entry.event === "continue_used")?.payload).toMatchObject({ source: "dev" });
  });

  it("отказ закрывает забег смертью ровно один раз", async () => {
    const fake = await downed();

    useRun.getState().declineContinue();

    expect(fake.calls).toEqual(["decline"]);
    expect(useRun.getState().phase).toBe("finished");
    expect(useMeta.getState().runs).toBe(1);
    expect(storage.values[DOWNED_KEY]).toBe("null");
    expect(events.filter((event) => event === "run_finished")).toHaveLength(1);
  });

  it("уход с экрана смерти и «Ещё раз» — тоже отказ, а не потерянный забег", async () => {
    const left = await downed();
    useRun.getState().stop();
    expect(left.calls).toEqual(["decline"]);
    expect(useMeta.getState().runs).toBe(1);

    const again = await downed();
    useRun.getState().restart();
    expect(again.calls).toEqual(["decline", "restart"]);
    expect(useMeta.getState().runs).toBe(2);
  });

  it("брошенный на экране смерти забег закрывается при следующем запуске — один раз", async () => {
    await downed();
    // Приложение закрыли, не решив: сессии больше нет, итог лежит на устройстве.
    useRun.setState({ phase: "idle" });
    recoverDownedRun();
    recoverDownedRun();

    expect(useMeta.getState().runs).toBe(1);
    expect(useMeta.getState().best.normal).toBe(250);
    expect(storage.values[DOWNED_KEY]).toBe("null");
    expect(events.filter((event) => event === "run_finished")).toHaveLength(1);
  });

  it("итог, брошенный на экране смерти, несёт счётчики итога в событие закрытия (T-0125)", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(OPTIONS);
    fake.emit("downed", { result: result({ bossKills: 1, eliteKills: 3, chestsOpened: 2, crystalsCollected: 420 }), continuesLeft: 1 });
    useRun.setState({ phase: "idle" });
    recoverDownedRun();

    const finished = payloads.find((entry) => entry.event === "run_finished");
    expect(finished?.payload).toMatchObject({ bossKills: 1, eliteKills: 3, chestsOpened: 2, crystals: 420 });
  });

  it("итог прошлой сборки без счётчиков разбирается: в событие идут нули", () => {
    const legacy: Record<string, unknown> = { ...result({ runId: "run-old" }) };
    for (const key of ["bossKills", "eliteKills", "chestsOpened", "crystalsCollected"]) delete legacy[key];
    storage.set(DOWNED_KEY, JSON.stringify({ result: legacy, countInRating: false }));

    recoverDownedRun();

    expect(useMeta.getState().runs).toBe(1);
    const finished = payloads.find((entry) => entry.event === "run_finished");
    expect(finished?.payload).toMatchObject({ bossKills: 0, eliteKills: 0, chestsOpened: 0, crystals: 0 });
  });

  it("где окна оплаты нет, второй шанс — только в забеге разработчика: купить его негде", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(OPTIONS);

    expect(fake.started[0]?.continues).toBe(false);
  });
});

describe("способы второго шанса: самоцветы (Р162)", () => {
  const AD_READY = { kind: "ready", pass: false, notice: null } as const;
  const AD_VIP = { kind: "ready", pass: true, notice: null } as const;
  const AD_GONE = { kind: "unavailable", reason: "daily_cap" } as const;
  const STARS_READY = { kind: "ready", offer: { continueNo: 1, priceStars: 7, chargedStars: 7, mode: "live" } } as const;
  const STARS_GONE = { kind: "unavailable", reason: "used_up" } as const;
  const GEMS_READY = { kind: "ready", offer: { continueNo: 1, priceGems: 5, balance: 12 }, notice: null } as const;
  const GEMS_GONE = { kind: "unavailable", reason: "used_up" } as const;

  afterEach(() => useRun.getState().stop());

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
    useMeta.getState().hydrate();
    useSavedRun.getState().hydrate();
  });

  it("есть ролик — он первый, самоцветы и звёзды второй строкой", () => {
    const ways = visibleWays({ adStage: AD_READY, paidStage: STARS_READY, gemStage: GEMS_READY });
    expect(ways).toEqual({ ad: true, gems: true, stars: true, vip: false });
    expect(wayOrder(ways)).toEqual(["ad", "gems", "stars"]);
  });

  it("ролика нет — самоцветы первые, звёзды вторые", () => {
    const ways = visibleWays({ adStage: AD_GONE, paidStage: STARS_READY, gemStage: GEMS_READY });
    expect(ways).toEqual({ ad: false, gems: true, stars: true, vip: false });
    expect(wayOrder(ways)).toEqual(["gems", "stars"]);
  });

  it("VIP — одна кнопка: ни самоцветов, ни звёзд", () => {
    const ways = visibleWays({ adStage: AD_VIP, paidStage: STARS_READY, gemStage: GEMS_READY });
    expect(ways).toEqual({ ad: false, gems: false, stars: false, vip: true });
    expect(wayOrder(ways)).toEqual(["vip"]);
  });

  it("сервер ответил «недоступно» по самоцветам — кнопки нет", () => {
    const ways = visibleWays({ adStage: AD_READY, paidStage: STARS_READY, gemStage: GEMS_GONE });
    expect(ways.gems).toBe(false);
    expect(wayOrder(ways)).toEqual(["ad", "stars"]);
  });

  it("звёзд нет, а самоцветы есть — недоступный блок звёзд не занимает место", () => {
    const ways = visibleWays({ adStage: AD_GONE, paidStage: STARS_GONE, gemStage: GEMS_READY });
    expect(wayOrder(ways)).toEqual(["gems"]);
  });

  it("отпали все три способа — забег закрыт смертью ровно один раз", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(OPTIONS);
    fake.emit("downed", { result: result(), continuesLeft: 1 });
    expectOffers(["ad", "gems", "stars"]);

    closeOffer("gems");
    closeOffer("stars");
    expect(fake.calls).toEqual([]);
    closeOffer("ad");

    expect(fake.calls).toEqual(["decline"]);
    expect(useRun.getState().phase).toBe("finished");
  });

  it("continue_offered несёт gems", () => {
    expect(continueOfferedPayload({ adStage: AD_READY, paidStage: STARS_READY, gemStage: GEMS_READY }, 311.6)).toEqual({ ad: true, gems: true, stars: true, vip: false, elapsedSec: 312 });
    expect(continueOfferedPayload({ adStage: AD_GONE, paidStage: STARS_READY, gemStage: GEMS_GONE }, 50)).toEqual({ ad: false, gems: false, stars: true, vip: false, elapsedSec: 50 });
    expect(continueOfferedPayload({ adStage: AD_VIP, paidStage: STARS_READY, gemStage: GEMS_READY }, 90)).toEqual({ ad: false, gems: false, stars: false, vip: true, elapsedSec: 90 });
  });

  it("пока самоцветы спрашивают сервер, событие не уходит; все отпали — события нет", () => {
    expect(continueOfferedPayload({ adStage: AD_READY, paidStage: STARS_READY, gemStage: { kind: "loading" } }, 100)).toBeNull();
    expect(continueOfferedPayload({ adStage: AD_GONE, paidStage: STARS_GONE, gemStage: GEMS_GONE }, 100)).toBeNull();
  });
});
