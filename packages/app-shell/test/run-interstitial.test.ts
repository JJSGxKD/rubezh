import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunSession, RunSnapshot } from "@bh/core-game";
import type { InterstitialResult } from "../src/state/interstitial";

// Межстраничная в старте забега (docs/35-stage4-plan.md WP12, часть 10):
// «Играть» — параллельно с движком, «Ещё раз» — до перезапуска; ушли в
// меню, пока её ждали, — забега нет; ждать нечего — забег сразу. Что
// показать, стору отдаёт экран забега; без рекламы на площадке привратник
// не делает ни запроса, ни ожидания.

const engine = vi.hoisted(() => ({ load: vi.fn() }));
const gate = vi.hoisted(() => ({ before: vi.fn<(moment: string, alive: () => boolean) => Promise<InterstitialResult>>() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));
vi.mock("../src/state/interstitial", () => ({ interstitialBeforeRun: gate.before }));

const { useRun } = await import("../src/state/run");
const { initShell } = await import("../src/state/shell");
const { interstitialBeforeNewRun } = await import("../src/state/interstitial-gate");

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

function fakeEngine(): { engine: RunEngine; restarts: number[] } {
  const handlers: Handlers = {};
  const restarts: number[] = [];
  const session = {
    on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    chooseUpgrade: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    abandon: () => undefined,
    declineContinue: () => undefined,
    restart: (seed: number) => void restarts.push(seed),
    snapshot: () => null,
    destroy: () => undefined,
  } as unknown as RunSession;
  return { engine: { start: () => session }, restarts };
}

function shell(options: { ads: boolean; auth?: boolean }): void {
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined, ...(options.ads ? { showAd: async () => ({ kind: "completed" }) } : {}) } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, ...(options.auth === false ? {} : { auth: { baseUrl: "" } }) },
    storage: undefined,
    analytics: () => undefined,
    build: { version: "test", contentHash: "", platform: "web" },
  });
}

/** Межстраничная, которую тест отпускает сам; `calls` — сколько раз её просили. */
function heldAd() {
  let release: (result: InterstitialResult) => void = () => undefined;
  const before = vi.fn((_alive: () => boolean) => new Promise<InterstitialResult>((resolve) => (release = resolve)));
  return { before, release: (result: InterstitialResult) => release(result) };
}

function options(beforeNewRun?: (alive: () => boolean) => Promise<InterstitialResult> | null) {
  return { container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" as const, ...(beforeNewRun === undefined ? {} : { beforeNewRun }) };
}

describe("межстраничная в старте забега", () => {
  beforeEach(() => {
    engine.load.mockReset();
    gate.before.mockReset();
    shell({ ads: true });
    useRun.getState().stop();
  });

  it("«Играть»: забег ждёт и движок, и межстраничную — параллельно, а не друг за другом", async () => {
    engine.load.mockResolvedValue(fakeEngine().engine);
    const ad = heldAd();
    const starting = useRun.getState().start(options(ad.before));
    await vi.waitFor(() => expect(ad.before).toHaveBeenCalledTimes(1));
    expect(engine.load).toHaveBeenCalledTimes(1);
    expect(useRun.getState().phase).toBe("loading");
    ad.release("shown");
    await starting;
    expect(useRun.getState().phase).toBe("running");
  });

  it("продолженный забег межстраничную не ждёт и не спрашивает", async () => {
    engine.load.mockResolvedValue(fakeEngine().engine);
    const ad = heldAd();
    // Снимок — ровно то, что стор читает у продолженного забега.
    const snapshot = { seed: 7, summary: { survivalSec: 90, level: 4 } } as unknown as RunSnapshot;
    await useRun.getState().start({ ...options(ad.before), resume: snapshot });
    expect(ad.before).not.toHaveBeenCalled();
    expect(useRun.getState().phase).not.toBe("loading");
  });

  it("«Ещё раз»: кнопка ждёт межстраничную, второе нажатие не считается, забег — после неё", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    // «Играть» прошёл без рекламы; держим межстраничную у «Ещё раз».
    const ad = heldAd();
    const before = vi.fn<(alive: () => boolean) => Promise<InterstitialResult>>().mockResolvedValueOnce("skipped").mockImplementation(ad.before);
    await useRun.getState().start(options(before));
    useRun.setState({ phase: "finished" });

    useRun.getState().restart();
    useRun.getState().restart();
    expect(useRun.getState().restarting).toBe(true);
    expect(before).toHaveBeenCalledTimes(2);
    expect(fake.restarts).toEqual([]);

    ad.release("shown");
    await vi.waitFor(() => expect(fake.restarts).toHaveLength(1));
    expect(useRun.getState()).toMatchObject({ phase: "running", restarting: false });
  });

  it("ушёл в меню, пока ждали межстраничную, — нового забега нет", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    const ad = heldAd();
    const before = vi.fn<(alive: () => boolean) => Promise<InterstitialResult>>().mockResolvedValueOnce("skipped").mockImplementation(ad.before);
    await useRun.getState().start(options(before));
    useRun.setState({ phase: "finished" });

    useRun.getState().restart();
    const alive = before.mock.calls[1]?.[0];
    expect(alive?.()).toBe(true);
    useRun.getState().stop();
    expect(alive?.()).toBe(false);
    ad.release("skipped");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.restarts).toEqual([]);
    expect(useRun.getState()).toMatchObject({ phase: "idle", restarting: false });
  });

  it("ждать нечего — «Ещё раз» сразу, как раньше", async () => {
    const fake = fakeEngine();
    engine.load.mockResolvedValue(fake.engine);
    await useRun.getState().start(options(() => null));
    useRun.setState({ phase: "finished" });
    useRun.getState().restart();
    expect(fake.restarts).toHaveLength(1);
    expect(useRun.getState().restarting).toBe(false);
  });
});

describe("привратник межстраничной", () => {
  beforeEach(() => {
    gate.before.mockReset();
  });

  it("площадка без рекламы или игрок без входа — ни запроса, ни ожидания", () => {
    shell({ ads: false });
    expect(interstitialBeforeNewRun(() => true)).toBeNull();
    shell({ ads: true, auth: false });
    expect(interstitialBeforeNewRun(() => true)).toBeNull();
    expect(gate.before).not.toHaveBeenCalled();
  });

  it("реклама есть — спрашивает межстраничную при старте забега; сбой — забег без неё", async () => {
    shell({ ads: true });
    gate.before.mockResolvedValue("shown");
    expect(await interstitialBeforeNewRun(() => true)).toBe("shown");
    expect(gate.before).toHaveBeenCalledWith("run_start", expect.any(Function));
    gate.before.mockRejectedValue(new Error("сломался"));
    expect(await interstitialBeforeNewRun(() => true)).toBe("skipped");
  });
});
