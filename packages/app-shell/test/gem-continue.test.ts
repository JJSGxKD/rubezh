import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunSession } from "@bh/core-game";
import type { ApiResult } from "../src/state/api-request";
import type { GemContinueApi, GemContinueReceipt, GemContinueView as ServerView } from "../src/state/gem-continue";

// Второй шанс за самоцветы на экране смерти (docs/35-stage4-plan.md Р162,
// tasks/T-0325). Проверяется то, где покупка обычно ломается: продолжение до
// ответа сервера, повтор, списывающий дважды, нехватка, о которой игрок узнаёт
// после нажатия, и экран смерти, который не знает, что способ отпал.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { useRun } = await import("../src/state/run");
const { useMeta } = await import("../src/state/meta");
const { useWallet } = await import("../src/state/wallet");
const { initShell } = await import("../src/state/shell");
const { gemOffer, setGemContinueDepsForTests, useGemContinue } = await import("../src/state/gem-continue");
const { GemContinueView } = await import("../src/screens/run/GemContinue");
const { closeOffer, expectOffers } = await import("../src/state/second-chance-offers");

function result(): RunResult {
  return {
    runId: "run-gem-1",
    seed: 42,
    outcome: "died",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "hard",
    contentHash: "abc",
    waveReached: 5,
    survivalSec: 300.4,
    level: 10,
    xpCollected: 500,
    enemiesKilled: 600,
    killsByEnemy: { swarm_rat: 600 },
    damageDealt: 8000,
    damageTaken: 250,
    damageByElement: {},
    bossKills: 0,
    eliteKills: 0,
    chestsOpened: 0,
    crystalsCollected: 0,
    weapons: [{ id: "spark", level: 5, damage: 8000 }],
    passives: [],
    deathCause: "swarm_rat",
    distance: 10_000,
    peakEnemies: 90,
    cheats: false,
    continues: [],
  };
}

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

function fakeEngine() {
  const handlers: Handlers = {};
  const calls: string[] = [];
  const emit = <E extends keyof RunEvents>(event: E, payload: RunEvents[E]): void =>
    (handlers[event] as ((value: typeof payload) => void) | undefined)?.(payload);
  const session = {
    on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    continueRun: (options?: { cheat?: boolean }) => {
      calls.push(options?.cheat === true ? "continue:cheat" : "continue");
      emit("revived", { elapsedSec: 300, continuesUsed: 1 });
    },
    declineContinue: () => {
      calls.push("decline");
      emit("finished", result());
    },
    restart: () => undefined,
    abandon: () => undefined,
    snapshot: () => null,
    destroy: () => undefined,
  } as unknown as RunSession;
  const fake: RunEngine = { start: () => session };
  return { engine: fake, emit, calls };
}

/** Сервер в памяти: ответы задаёт тест, запросы он же и видит. */
class FakeServer implements GemContinueApi {
  views: ApiResult<ServerView>[] = [];
  buys: ApiResult<GemContinueReceipt>[] = [];
  readonly asked: string[] = [];

  async view(runId: string, elapsedSec: number): Promise<ApiResult<ServerView>> {
    this.asked.push(`view:${runId}:${elapsedSec}`);
    return this.views.shift() ?? { ok: true, data: { status: "available", continueNo: 1, priceGems: 5, balance: 12 } };
  }

  async buy(runId: string, continueNo: number, elapsedSec: number): Promise<ApiResult<GemContinueReceipt>> {
    this.asked.push(`buy:${runId}:${continueNo}:${elapsedSec}`);
    return this.buys.shift() ?? { ok: true, data: { continueNo, priceGems: 5, balance: 7 } };
  }
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

let server: FakeServer;
let events: { event: string; payload: Record<string, unknown> }[];
let sleeps: number;

async function downed(offers: readonly ("stars" | "ad" | "gems")[] = ["gems"]): Promise<ReturnType<typeof fakeEngine>> {
  const fake = fakeEngine();
  engine.load.mockResolvedValue(fake.engine);
  await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "hard" });
  fake.emit("downed", { result: result(), continuesLeft: 1 });
  expectOffers(offers);
  return fake;
}

describe("второй шанс за самоцветы", () => {
  beforeEach(async () => {
    engine.load.mockReset();
    server = new FakeServer();
    events = [];
    sleeps = 0;
    setGemContinueDepsForTests({
      api: server,
      sleep: async () => {
        sleeps++;
      },
    });
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, auth: { baseUrl: "" } },
      storage: memoryStorage(),
      analytics: (event, payload) => void events.push({ event, payload: payload ?? {} }),
      build: { version: "test", contentHash: "abc", platform: "telegram" },
    });
    useMeta.getState().hydrate();
    useWallet.setState({ balances: { coins: 100, gems: 12 } });
    useGemContinue.getState().reset();
  });

  afterEach(() => {
    useGemContinue.getState().reset();
    useRun.getState().stop();
  });

  it("сервер ответил «доступно» — цена и баланс известны, секунда забега уходит как есть", async () => {
    await downed();
    await useGemContinue.getState().prepare(result());

    expect(useGemContinue.getState().stage).toEqual({ kind: "ready", offer: { continueNo: 1, priceGems: 5, balance: 12 }, notice: null });
    expect(server.asked).toEqual(["view:run-gem-1:300.4"]);
    expect(gemOffer({ continueNo: 1, priceGems: 5, balance: 12 })).toEqual({ affordable: true, shortfall: 0 });
  });

  it("самоцветов меньше цены — кнопка выключена, подпись «Не хватает N», нажатие ничего не шлёт", async () => {
    await downed();
    server.views = [{ ok: true, data: { status: "available", continueNo: 1, priceGems: 5, balance: 3 } }];
    await useGemContinue.getState().prepare(result());
    const stage = useGemContinue.getState().stage;
    expect(gemOffer({ continueNo: 1, priceGems: 5, balance: 3 })).toEqual({ affordable: false, shortfall: 2 });

    const markup = renderToStaticMarkup(createElement(GemContinueView, { stage, locked: false, primary: true, onBuy: () => undefined }));
    expect(markup).toContain("Не хватает 2");
    expect(markup).toContain("У вас 3");
    expect(markup).toContain("disabled");

    await useGemContinue.getState().buy();
    expect(server.asked).toEqual(["view:run-gem-1:300.4"]);
  });

  it("хватает — цена значком и числом, баланс под кнопкой, кнопка доступна", async () => {
    await downed();
    await useGemContinue.getState().prepare(result());

    const markup = renderToStaticMarkup(createElement(GemContinueView, { stage: useGemContinue.getState().stage, locked: false, primary: true, onBuy: () => undefined }));
    expect(markup).toContain("Продолжить");
    expect(markup).toContain("У вас 12");
    expect(markup).not.toContain("Не хватает");
    expect(markup).not.toMatch(/<button[^>]*disabled/);
  });

  it("пока спрашиваем сервер — заглушка той же кнопки, а не пустое место", () => {
    const markup = renderToStaticMarkup(createElement(GemContinueView, { stage: { kind: "loading" }, locked: false, primary: true, onBuy: () => undefined }));
    expect(markup).toContain("<button");
  });

  it("покупка — продолжение по ответу сервера; баланс кошелька из ответа; событие с источником «gems»", async () => {
    const fake = await downed();
    await useGemContinue.getState().prepare(result());

    await useGemContinue.getState().buy();

    expect(server.asked).toEqual(["view:run-gem-1:300.4", "buy:run-gem-1:1:300.4"]);
    expect(fake.calls).toEqual(["continue"]);
    expect(useWallet.getState().balances?.gems).toBe(7);
    expect(events.find((entry) => entry.event === "continue_used")?.payload).toMatchObject({ source: "gems" });
    expect(useRun.getState().phase).toBe("running");
  });

  it("недостаточно средств по ответу сервера — способ отпал, забег ждёт звёзды", async () => {
    const fake = await downed(["gems", "stars"]);
    await useGemContinue.getState().prepare(result());
    server.buys = [{ ok: false, failure: "rejected", code: "insufficient_funds" }];

    await useGemContinue.getState().buy();

    expect(useGemContinue.getState().stage).toEqual({ kind: "unavailable", reason: "insufficient_funds" });
    expect(fake.calls).toEqual([]);
    expect(useRun.getState().phase).toBe("downed");

    closeOffer("stars");
    expect(fake.calls).toEqual(["decline"]);
  });

  it("продолжение уже взято другим способом — способ отпал с подписью", async () => {
    await downed(["gems", "ad"]);
    await useGemContinue.getState().prepare(result());
    server.buys = [{ ok: false, failure: "rejected", code: "continue_taken" }];

    await useGemContinue.getState().buy();

    expect(useGemContinue.getState().stage).toEqual({ kind: "unavailable", reason: "taken" });
  });

  it("обрыв сети — кнопка остаётся, повтор уходит с тем же номером и секундой", async () => {
    const fake = await downed();
    await useGemContinue.getState().prepare(result());
    server.buys = [{ ok: false, failure: "offline" }];

    await useGemContinue.getState().buy();
    expect(useGemContinue.getState().stage).toMatchObject({ kind: "ready", notice: "offline" });
    expect(fake.calls).toEqual([]);

    await useGemContinue.getState().buy();

    expect(server.asked).toEqual(["view:run-gem-1:300.4", "buy:run-gem-1:1:300.4", "buy:run-gem-1:1:300.4"]);
    expect(fake.calls).toEqual(["continue"]);
  });

  it("пока идёт покупка, вторая не стартует", async () => {
    await downed();
    await useGemContinue.getState().prepare(result());
    let release: () => void = () => undefined;
    server.buy = (runId, continueNo, elapsedSec) => {
      server.asked.push(`buy:${runId}:${continueNo}:${elapsedSec}`);
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, data: { continueNo, priceGems: 5, balance: 7 } });
      });
    };

    const first = useGemContinue.getState().buy();
    expect(useGemContinue.getState().stage.kind).toBe("buying");
    await useGemContinue.getState().buy();
    release();
    await first;

    expect(server.asked.filter((line) => line.startsWith("buy:"))).toHaveLength(1);
  });

  it("сервер ответил «недоступно» — кнопки нет, предложение закрыто, забег ждёт остальных", async () => {
    const fake = await downed(["gems", "ad"]);
    server.views = [{ ok: true, data: { status: "unavailable", reason: "used_up" } }];
    await useGemContinue.getState().prepare(result());

    expect(useGemContinue.getState().stage).toEqual({ kind: "unavailable", reason: "used_up" });
    expect(fake.calls).toEqual([]);

    closeOffer("ad");
    expect(fake.calls).toEqual(["decline"]);
  });

  it("сервер не видел старта забега — один повтор вопроса после паузы", async () => {
    await downed();
    server.views = [{ ok: false, failure: "rejected", code: "run_unverified" }];

    await useGemContinue.getState().prepare(result());

    expect(sleeps).toBe(1);
    expect(server.asked).toHaveLength(2);
    expect(useGemContinue.getState().stage.kind).toBe("ready");
  });

  it("нет связи при вопросе о цене — способ отпал: без сервера самоцветы не списать", async () => {
    await downed(["gems", "stars"]);
    server.views = [{ ok: false, failure: "offline" }];

    await useGemContinue.getState().prepare(result());

    expect(useGemContinue.getState().stage).toEqual({ kind: "unavailable", reason: "not_offered" });
  });

  it("ответ по чужому забегу отбрасывается", async () => {
    await downed();
    const first = useGemContinue.getState().prepare(result());
    useGemContinue.getState().reset();
    await first;

    expect(useGemContinue.getState().stage).toEqual({ kind: "idle" });
  });
});
