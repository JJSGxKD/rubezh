import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunSession } from "@bh/core-game";
import type { AdWatchResult } from "../src/state/ad-watch";
import type { AdContinueApi, AdContinueView } from "../src/state/ad-continue";
import type { ApiResult } from "../src/state/api-request";

// Второй шанс за рекламу на экране смерти (docs/35-stage4-plan.md WP11, Р4).
// Проверяется то, где он обычно ломается: продолжение по ответу SDK, а не
// сервера; второй ролик после потерянного ответа; и экран смерти, который
// закрывается, пока ещё можно продолжить звёздами, — или ждёт, когда
// продолжить уже нечем.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { useRun } = await import("../src/state/run");
const { useMeta } = await import("../src/state/meta");
const { initShell } = await import("../src/state/shell");
const { setAdContinueDepsForTests, useAdContinue } = await import("../src/state/ad-continue");
const { closeOffer, expectOffers } = await import("../src/state/second-chance-offers");

function result(): RunResult {
  return {
    runId: "run-ad-1",
    seed: 42,
    outcome: "died",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "normal",
    contentHash: "abc",
    waveReached: 5,
    survivalSec: 300,
    level: 10,
    xpCollected: 500,
    enemiesKilled: 600,
    killsByEnemy: { swarm_rat: 600 },
    damageDealt: 8000,
    damageTaken: 250,
    damageByElement: {},
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
class FakeServer implements AdContinueApi {
  views: ApiResult<AdContinueView>[] = [];
  claims: ApiResult<{ continueNo: number }>[] = [];
  readonly asked: string[] = [];

  async view(runId: string): Promise<ApiResult<AdContinueView>> {
    this.asked.push(`view:${runId}`);
    return this.views.shift() ?? { ok: true, data: { status: "available", continueNo: 1, pass: null } };
  }

  async claim(runId: string, sessionId: string): Promise<ApiResult<{ continueNo: number }>> {
    this.asked.push(`claim:${runId}:${sessionId}`);
    return this.claims.shift() ?? { ok: true, data: { continueNo: 1 } };
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
let outcomes: AdWatchResult[];
let watched: number;
let rewarded: string[];
let events: { event: string; payload: Record<string, unknown> }[];

async function downed(offers: readonly ("stars" | "ad")[] = ["ad"]): Promise<ReturnType<typeof fakeEngine>> {
  const fake = fakeEngine();
  engine.load.mockResolvedValue(fake.engine);
  await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" });
  fake.emit("downed", { result: result(), continuesLeft: 1 });
  expectOffers(offers);
  return fake;
}

describe("второй шанс за рекламу", () => {
  beforeEach(() => {
    engine.load.mockReset();
    server = new FakeServer();
    outcomes = [];
    watched = 0;
    rewarded = [];
    events = [];
    setAdContinueDepsForTests({
      api: server,
      watch: async () => {
        watched++;
        return outcomes.shift() ?? { kind: "watched", sessionId: "AAAAAAAAAAAAAAAA", source: "ad" };
      },
      rewarded: (source) => void rewarded.push(source),
      sleep: async () => undefined,
    });
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: () => undefined, showAd: async () => ({ kind: "completed" }) } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, auth: { baseUrl: "" } },
      storage: memoryStorage(),
      analytics: (event, payload) => void events.push({ event, payload: payload ?? {} }),
      build: { version: "test", contentHash: "abc", platform: "telegram" },
    });
    useMeta.getState().hydrate();
    useAdContinue.getState().reset();
  });

  afterEach(() => {
    useAdContinue.getState().reset();
    useRun.getState().stop();
  });

  it("досмотр — продолжение по ответу сервера; награда отмечается, а событие продолжения — с источником", async () => {
    const fake = await downed();
    await useAdContinue.getState().prepare(result());
    expect(useAdContinue.getState().stage).toEqual({ kind: "ready", pass: false, notice: null });

    await useAdContinue.getState().watch();

    expect(server.asked).toEqual(["view:run-ad-1", "claim:run-ad-1:AAAAAAAAAAAAAAAA"]);
    expect(fake.calls).toEqual(["continue"]);
    expect(rewarded).toEqual(["ad"]);
    expect(events.find((entry) => entry.event === "continue_used")?.payload).toMatchObject({ source: "ad" });
    expect(useRun.getState().phase).toBe("running");
  });

  it("VIP — без ролика: кнопка знает это заранее, продолжение помечено пропуском", async () => {
    const fake = await downed();
    server.views = [{ ok: true, data: { status: "available", continueNo: 1, pass: "vip" } }];
    outcomes = [{ kind: "watched", sessionId: "BBBBBBBBBBBBBBBB", source: "pass" }];
    await useAdContinue.getState().prepare(result());
    expect(useAdContinue.getState().stage).toEqual({ kind: "ready", pass: true, notice: null });

    await useAdContinue.getState().watch();

    expect(fake.calls).toEqual(["continue"]);
    expect(events.find((entry) => entry.event === "continue_used")?.payload).toMatchObject({ source: "pass" });
  });

  it("закрыл ролик — строка, продолжения нет, кнопка снова доступна", async () => {
    const fake = await downed();
    outcomes = [{ kind: "closed" }];
    await useAdContinue.getState().prepare(result());
    await useAdContinue.getState().watch();

    expect(useAdContinue.getState().stage).toEqual({ kind: "ready", pass: false, notice: "closed" });
    expect(server.asked).toEqual(["view:run-ad-1"]);
    expect(fake.calls).toEqual([]);
  });

  it("ролик досмотрен, а сервер не ответил — повтор забирает ту же сессию без второго ролика", async () => {
    const fake = await downed();
    server.claims = [{ ok: false, failure: "offline" }];
    await useAdContinue.getState().prepare(result());

    await useAdContinue.getState().watch();
    expect(useAdContinue.getState().stage).toEqual({ kind: "ready", pass: false, notice: "claim_failed" });
    expect(fake.calls).toEqual([]);

    await useAdContinue.getState().watch();
    expect(watched).toBe(1);
    expect(server.asked.filter((entry) => entry.startsWith("claim"))).toEqual(["claim:run-ad-1:AAAAAAAAAAAAAAAA", "claim:run-ad-1:AAAAAAAAAAAAAAAA"]);
    expect(fake.calls).toEqual(["continue"]);
  });

  it("рекламы нет, а звёзды ещё можно купить — забег ждёт; отпали и звёзды — закрывается смертью", async () => {
    const fake = await downed(["stars", "ad"]);
    outcomes = [{ kind: "no_ads" }];
    await useAdContinue.getState().prepare(result());
    await useAdContinue.getState().watch();

    expect(useAdContinue.getState().stage).toEqual({ kind: "unavailable", reason: "no_ads_now" });
    expect(fake.calls).toEqual([]);
    expect(useRun.getState().phase).toBe("downed");

    closeOffer("stars");
    expect(fake.calls).toEqual(["decline"]);
    expect(useRun.getState().phase).toBe("finished");
  });

  it("рекламных на сегодня больше нет — кнопка уходит; если это был единственный способ, ждать нечего", async () => {
    const fake = await downed();
    server.views = [{ ok: true, data: { status: "unavailable", reason: "daily_cap" } }];
    await useAdContinue.getState().prepare(result());

    expect(useAdContinue.getState().stage).toEqual({ kind: "unavailable", reason: "daily_cap" });
    expect(fake.calls).toEqual(["decline"]);
  });

  it("лимит упёрся при заборе — тот же итог; продолжение уже взято — кнопка уходит молча", async () => {
    await downed(["stars", "ad"]);
    server.claims = [{ ok: false, failure: "rejected", code: "ad_continue_daily_cap" }];
    await useAdContinue.getState().prepare(result());
    await useAdContinue.getState().watch();
    expect(useAdContinue.getState().stage).toEqual({ kind: "unavailable", reason: "daily_cap" });

    useAdContinue.getState().reset();
    useRun.getState().stop();
    await downed(["stars", "ad"]);
    server.claims = [{ ok: false, failure: "rejected", code: "continue_taken" }];
    await useAdContinue.getState().prepare(result());
    await useAdContinue.getState().watch();
    expect(useAdContinue.getState().stage).toEqual({ kind: "unavailable", reason: "used_up" });
  });

  it("награды за рекламу закрыты ограничением — строка «срок и причина в профиле», при выдаче и при заборе", async () => {
    await downed(["stars", "ad"]);
    outcomes = [{ kind: "restricted" }];
    await useAdContinue.getState().prepare(result());
    await useAdContinue.getState().watch();
    expect(useAdContinue.getState().stage).toEqual({ kind: "unavailable", reason: "restricted" });

    useAdContinue.getState().reset();
    useRun.getState().stop();
    await downed(["stars", "ad"]);
    server.claims = [{ ok: false, failure: "disabled", code: "account_restricted" }];
    await useAdContinue.getState().prepare(result());
    await useAdContinue.getState().watch();
    expect(useAdContinue.getState().stage).toEqual({ kind: "unavailable", reason: "restricted" });
  });

  it("сервер не видел старта — спрашивает ещё раз; ответ по ушедшему забегу ничего не меняет", async () => {
    await downed();
    server.views = [{ ok: false, failure: "rejected", code: "run_unverified" }];
    await useAdContinue.getState().prepare(result());
    expect(server.asked).toEqual(["view:run-ad-1", "view:run-ad-1"]);
    expect(useAdContinue.getState().stage).toMatchObject({ kind: "ready" });

    const late = useAdContinue.getState().watch();
    useAdContinue.getState().reset();
    await late;
    expect(useAdContinue.getState().stage).toEqual({ kind: "idle" });
    expect(server.asked.filter((entry) => entry.startsWith("claim"))).toHaveLength(0);
  });
});
