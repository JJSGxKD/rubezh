import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";
import type { RunEngine, RunOptions, RunSession } from "@bh/core-game";
import type { ApiRequest } from "../src/state/api-request";
import { buyBoosts, createBoostsApi, type BoostCatalog } from "../src/state/boosts-api";

// Бусты на забег в оболочке (docs/35-stage4-plan.md §3.5, Р39): купленные
// уходят в движок вместе с id забега, забег, который не начался, их
// возвращает, а покупка пишет `boost_used` по бусту.

const mocks = vi.hoisted(() => ({ load: vi.fn(), refund: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: mocks.load,
}));

vi.mock("../src/state/boosts-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/state/boosts-api")>()),
  refundBoosts: mocks.refund,
}));

const { useRun } = await import("../src/state/run");
const { initShell } = await import("../src/state/shell");

const CATALOG: BoostCatalog = {
  boosts: [
    { id: "fury", resource: "coins", amount: 150 },
    { id: "insight", resource: "gems", amount: 6 },
  ],
  maxPerRun: 3,
};

const events: { event: string; payload: Record<string, unknown> }[] = [];

function engineCapturing(options: RunOptions[]): RunEngine {
  const session = {
    on: () => () => undefined,
    restart: () => undefined,
    destroy: () => undefined,
    snapshot: () => null,
  } as unknown as RunSession;
  return {
    start: (runOptions: RunOptions) => {
      options.push(runOptions);
      return session;
    },
  };
}

const base = { container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" as const };

beforeEach(() => {
  events.length = 0;
  mocks.load.mockReset();
  mocks.refund.mockReset();
  mocks.refund.mockResolvedValue(undefined);
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage: undefined,
    analytics: (event, payload) => events.push({ event, payload }),
    build: { version: "test", contentHash: "", platform: "web" },
  });
  useRun.getState().stop();
});

describe("купленные бусты на старте забега", () => {
  it("уходят в движок вместе с id забега, на который куплены", async () => {
    const started: RunOptions[] = [];
    mocks.load.mockResolvedValue(engineCapturing(started));

    await useRun.getState().start({ ...base, boosts: { runId: "run-bought-1", ids: ["fury", "insight"] } });

    expect(started[0]).toMatchObject({ runId: "run-bought-1", loadout: { boosts: ["fury", "insight"] } });
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("забег, который не начался, возвращает бусты", async () => {
    mocks.load.mockRejectedValue(new Error("сеть"));

    await useRun.getState().start({ ...base, boosts: { runId: "run-bought-2", ids: ["fury"] } });

    expect(useRun.getState().phase).toBe("error");
    await vi.waitFor(() => expect(mocks.refund).toHaveBeenCalledWith("run-bought-2"));
  });

  it("двойной старт с той же покупкой — как React в режиме разработки — бусты не возвращает", async () => {
    const started: RunOptions[] = [];
    let resolveEngine: (engine: RunEngine) => void = () => undefined;
    mocks.load.mockReturnValue(new Promise<RunEngine>((resolve) => (resolveEngine = resolve)));
    const bought = { runId: "run-bought-5", ids: ["fury"] };

    const first = useRun.getState().start({ ...base, boosts: bought });
    useRun.getState().stop();
    const second = useRun.getState().start({ ...base, boosts: bought });
    resolveEngine(engineCapturing(started));
    await Promise.all([first, second]);

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ runId: "run-bought-5" });
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("ушёл с экрана загрузки — бусты возвращаются и снимаются с намерения", async () => {
    let resolveEngine: (engine: RunEngine) => void = () => undefined;
    mocks.load.mockReturnValue(new Promise<RunEngine>((resolve) => (resolveEngine = resolve)));
    const bought = { runId: "run-bought-6", ids: ["fury"] };
    useRun.getState().intend({ kind: "new", boosts: bought });

    const starting = useRun.getState().start({ ...base, boosts: bought });
    useRun.getState().stop();
    resolveEngine(engineCapturing([]));
    await starting;

    await vi.waitFor(() => expect(mocks.refund).toHaveBeenCalledWith("run-bought-6"));
    expect(useRun.getState().intent).toEqual({ kind: "new" });
  });

  it("забег без бустов id не навязывает, а набор не заводит", async () => {
    const started: RunOptions[] = [];
    mocks.load.mockResolvedValue(engineCapturing(started));

    await useRun.getState().start(base);

    expect(started[0]).not.toHaveProperty("runId");
    expect(started[0]).not.toHaveProperty("loadout");
  });
});

describe("покупка бустов", () => {
  function answering(body: unknown, failure?: { code: string }): ApiRequest {
    return async (_path, schema) => {
      if (failure !== undefined) return { ok: false, failure: "rejected", code: failure.code };
      const parsed = schema.safeParse(body);
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, failure: "unavailable" };
    };
  }

  it("подтверждённая сервером — событие на каждый буст, с ценой и чем оплачен", async () => {
    const api = createBoostsApi(answering({ runId: "run-3", boosts: ["fury", "insight"], cost: { coins: 150, gems: 6 } }));

    expect(await buyBoosts("run-3", ["fury", "insight"], CATALOG, api)).toEqual({ ok: true, runId: "run-3", boosts: ["fury", "insight"] });
    expect(events.filter(({ event }) => event === "boost_used").map(({ payload }) => payload)).toEqual([
      { boost: "fury", source: "coins", amount: 150, count: 2 },
      { boost: "insight", source: "gems", amount: 6, count: 2 },
    ]);
  });

  it("отказ — с кодом и без события: бусты не куплены", async () => {
    const api = createBoostsApi(answering(null, { code: "insufficient_funds" }));

    expect(await buyBoosts("run-4", ["fury"], CATALOG, api)).toEqual({ ok: false, failure: "rejected", code: "insufficient_funds" });
    expect(events.filter(({ event }) => event === "boost_used")).toEqual([]);
  });
});
