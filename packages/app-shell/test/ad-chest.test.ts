import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type ChestReward, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunSession } from "@bh/core-game";
import type { AdWatchResult } from "../src/state/ad-watch";
import type { AdChestApi, AdChestView } from "../src/state/ad-chest";
import type { ApiResult } from "../src/state/api-request";
import { adChestButton } from "../src/screens/run/chest-rules";

// Второй сундук клада за ролик в окне сундука (tasks/T-0328, Р162). Проверяется то, где он обычно
// ломается: сундук по ответу SDK, а не сервера; второй ролик после потерянного ответа; вопрос
// серверу, когда кнопки быть не может; кнопка, которая мигает или пережила забег; сундук
// элиты, у которого кнопки нет вовсе.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { useRun } = await import("../src/state/run");
const { useMeta } = await import("../src/state/meta");
const { toSubmission } = await import("../src/state/runs");
const { initShell } = await import("../src/state/shell");
const { setAdChestDepsForTests, useAdChest } = await import("../src/state/ad-chest");

const RUN_ID = "run-chest-1";

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
    closeChest: () => calls.push("closeChest"),
    openAdChest: () => calls.push("openAdChest"),
    restart: () => undefined,
    abandon: () => undefined,
    snapshot: () => null,
    destroy: () => undefined,
  } as unknown as RunSession;
  const fake: RunEngine = { start: () => session };
  return { engine: fake, emit, calls };
}

/** Сервер в памяти: ответы задаёт тест, запросы он же и видит. */
class FakeServer implements AdChestApi {
  views: ApiResult<AdChestView>[] = [];
  claims: ApiResult<{ granted: boolean }>[] = [];
  readonly asked: string[] = [];

  async view(runId: string): Promise<ApiResult<AdChestView>> {
    this.asked.push(`view:${runId}`);
    return this.views.shift() ?? { ok: true, data: { status: "available", pass: null } };
  }

  async claim(runId: string, sessionId: string): Promise<ApiResult<{ granted: boolean }>> {
    this.asked.push(`claim:${runId}:${sessionId}`);
    return this.claims.shift() ?? { ok: true, data: { granted: true } };
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
let playable: boolean;
let events: { event: string; payload: Record<string, unknown> }[];

const reward = (id: string): ChestReward => ({ id, kind: "weapon_new", refId: id, level: 1, nameKey: "n", descriptionKey: "d", changes: [] });

/** Забег идёт и открыт сундук: клад (`canAdChest`) или элиты. */
async function opened(patch: { canAdChest?: boolean; via?: "clad" } = {}): Promise<ReturnType<typeof fakeEngine>> {
  const fake = fakeEngine();
  engine.load.mockResolvedValue(fake.engine);
  await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "hard" });
  fake.emit("started", { runId: RUN_ID, difficultyId: "hard", startingWeaponId: "spark" });
  openChest(fake, patch);
  return fake;
}

function openChest(fake: ReturnType<typeof fakeEngine>, patch: { canAdChest?: boolean; via?: "clad" } = {}): void {
  fake.emit("chestOpened", {
    index: 0,
    size: 3,
    rewards: [reward("a"), reward("b"), reward("c")],
    fallbacks: 0,
    elapsedSec: 130,
    canAdChest: patch.canAdChest ?? true,
    ...(patch.via === undefined ? {} : { via: patch.via }),
  });
}

/** То, что передаёт экран: забег и то, что сказал движок. */
function input(patch: Partial<{ runId: string; canAdChest: boolean }> = {}) {
  return { runId: RUN_ID, canAdChest: true, ...patch };
}

describe("второй сундук клада за ролик в оболочке", () => {
  beforeEach(() => {
    engine.load.mockReset();
    server = new FakeServer();
    outcomes = [];
    watched = 0;
    playable = true;
    events = [];
    setAdChestDepsForTests({
      api: server,
      watch: async () => {
        watched++;
        return outcomes.shift() ?? { kind: "watched", sessionId: "AAAAAAAAAAAAAAAA", source: "ad" };
      },
      playable: () => playable,
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
    useAdChest.getState().reset();
  });

  afterEach(() => {
    useAdChest.getState().reset();
    useRun.getState().stop();
  });

  describe("кнопка по правилам", () => {
    it("видна, только когда движок обещает сундук, сервер сказал «можно» и второго сундука ещё нет", () => {
      const ready = { kind: "ready", pass: false } as const;
      expect(adChestButton({ canAdChest: true, stage: ready, taken: false })).toEqual({ kind: "ready", pass: false });
      expect(adChestButton({ canAdChest: true, stage: { kind: "ready", pass: true }, taken: false })).toEqual({ kind: "ready", pass: true });
      expect(adChestButton({ canAdChest: true, stage: { kind: "watching", pass: false }, taken: false })).toEqual({ kind: "busy" });

      expect(adChestButton({ canAdChest: false, stage: ready, taken: false })).toEqual({ kind: "hidden" });
      expect(adChestButton({ canAdChest: true, stage: ready, taken: true })).toEqual({ kind: "hidden" });
      for (const kind of ["idle", "checking", "gone"] as const) {
        expect(adChestButton({ canAdChest: true, stage: { kind }, taken: false }), kind).toEqual({ kind: "hidden" });
      }
    });
  });

  describe("окно сундука в состоянии забега", () => {
    it("сундук клада несёт «можно»; второй сундук ложится к первому, окно остаётся одним", async () => {
      const fake = await opened({ via: "clad" });
      expect(useRun.getState().phase).toBe("chest");
      expect(useRun.getState().chest).toMatchObject({ index: 0, size: 3, canAdChest: true });
      expect(useRun.getState().chest?.second).toBeUndefined();

      fake.emit("chestOpened", {
        index: 1,
        size: 3,
        rewards: [reward("d"), reward("e"), reward("f")],
        fallbacks: 1,
        elapsedSec: 130,
        canAdChest: false,
        via: "clad_ad",
      });

      const chest = useRun.getState().chest;
      expect(useRun.getState().phase).toBe("chest");
      expect(chest?.rewards.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
      expect(chest?.second?.rewards.map((entry) => entry.id)).toEqual(["d", "e", "f"]);
      expect(chest?.canAdChest).toBe(false);
    });

    it("сундук элиты кнопки не получает", async () => {
      await opened({ canAdChest: false });
      expect(useRun.getState().chest?.canAdChest).toBe(false);
    });

    it("аналитика: второй сундук — chest_found с источником clad_ad и chest_opened; первый — только chest_opened", async () => {
      const fake = await opened({ via: "clad" });
      expect(events.filter((entry) => entry.event === "chest_found")).toEqual([]);

      fake.emit("chestOpened", { index: 1, size: 3, rewards: [reward("d")], fallbacks: 0, elapsedSec: 130.4, canAdChest: false, via: "clad_ad" });
      expect(events.find((entry) => entry.event === "chest_found")?.payload).toEqual({ index: 1, size: 3, source: "clad_ad", elapsedSec: 130 });
      expect(events.filter((entry) => entry.event === "chest_opened")).toHaveLength(2);
    });

    it("openAdChest уходит движку только из окна сундука", async () => {
      const fake = await opened({ via: "clad" });
      useRun.getState().openAdChest();
      expect(fake.calls).toEqual(["openAdChest"]);

      useRun.getState().closeChest();
      fake.emit("resumed", { elapsedSec: 131 });
      useRun.getState().openAdChest();
      expect(fake.calls).toEqual(["openAdChest", "closeChest"]);
    });
  });

  describe("вопрос серверу", () => {
    it("движок не обещал сундука или площадка не показывает ролики — сервер не спрашивается, кнопки нет", async () => {
      await useAdChest.getState().prepare(input({ canAdChest: false }));
      playable = false;
      await useAdChest.getState().prepare(input());

      expect(server.asked).toEqual([]);
      expect(useAdChest.getState().stage).toEqual({ kind: "idle" });
    });

    it("«можно» — кнопка готова; у VIP — с пометкой пропуска", async () => {
      await useAdChest.getState().prepare(input());
      expect(server.asked).toEqual([`view:${RUN_ID}`]);
      expect(useAdChest.getState().stage).toEqual({ kind: "ready", pass: false });

      useAdChest.getState().reset();
      server.views = [{ ok: true, data: { status: "available", pass: "vip" } }];
      await useAdChest.getState().prepare(input());
      expect(useAdChest.getState().stage).toEqual({ kind: "ready", pass: true });
    });

    it("пока сервер отвечает, кнопки нет: стадия «проверяем»", async () => {
      let release: (value: ApiResult<AdChestView>) => void = () => undefined;
      let asked = 0;
      server.view = () => {
        asked++;
        return new Promise((resolve) => (release = resolve));
      };
      const asking = useAdChest.getState().prepare(input());
      expect(useAdChest.getState().stage).toEqual({ kind: "checking" });
      await vi.waitFor(() => expect(asked).toBe(1));
      release({ ok: true, data: { status: "available", pass: null } });
      await asking;
      expect(useAdChest.getState().stage).toEqual({ kind: "ready", pass: false });
    });

    it("unavailable — любая причина закрывает кнопку до конца забега: повторного вопроса нет", async () => {
      for (const reason of ["unverified", "finished", "used_up", "no_ads", "daily_cap"]) {
        useAdChest.getState().reset();
        server.asked.length = 0;
        server.views = [{ ok: true, data: { status: "unavailable", reason } }];
        await useAdChest.getState().prepare(input());
        expect(useAdChest.getState().stage, reason).toEqual({ kind: "gone" });
        expect(adChestButton({ canAdChest: true, stage: useAdChest.getState().stage, taken: false }).kind, reason).toBe("hidden");
        await useAdChest.getState().prepare(input());
        expect(server.asked, reason).toEqual([`view:${RUN_ID}`]);
      }
    });

    it("связи нет — рекламу не предлагаем: ролик без сервера не засчитать", async () => {
      server.views = [{ ok: false, failure: "offline" }];
      await useAdChest.getState().prepare(input());
      expect(useAdChest.getState().stage).toEqual({ kind: "gone" });
    });

    it("сервер не видел старта — одна пауза и второй вопрос", async () => {
      server.views = [{ ok: false, failure: "rejected", code: "run_unverified" }];
      await useAdChest.getState().prepare(input());
      expect(server.asked).toEqual([`view:${RUN_ID}`, `view:${RUN_ID}`]);
      expect(useAdChest.getState().stage).toEqual({ kind: "ready", pass: false });

      useAdChest.getState().reset();
      server.asked.length = 0;
      server.views = [
        { ok: false, failure: "rejected", code: "run_unverified" },
        { ok: false, failure: "rejected", code: "run_unverified" },
      ];
      await useAdChest.getState().prepare(input());
      expect(server.asked).toHaveLength(2);
      expect(useAdChest.getState().stage).toEqual({ kind: "gone" });
    });

    it("один вопрос на забег; второй клад того же забега кнопку не спрашивает заново; смена забега — спрашивает", async () => {
      await useAdChest.getState().prepare(input());
      await useAdChest.getState().prepare(input());
      expect(server.asked).toEqual([`view:${RUN_ID}`]);

      await useAdChest.getState().prepare(input({ runId: "run-chest-2" }));
      expect(server.asked).toEqual([`view:${RUN_ID}`, "view:run-chest-2"]);
      expect(useAdChest.getState()).toMatchObject({ runId: "run-chest-2", stage: { kind: "ready", pass: false }, watched: null });
    });
  });

  describe("нажатие", () => {
    it("показ и забор — openAdChest по ответу сервера, один раз; награда помечена местом clad_chest; кнопка уходит", async () => {
      const fake = await opened({ via: "clad" });
      await useAdChest.getState().prepare(input());
      expect(useAdChest.getState().stage).toEqual({ kind: "ready", pass: false });

      await useAdChest.getState().watch();

      expect(server.asked).toEqual([`view:${RUN_ID}`, `claim:${RUN_ID}:AAAAAAAAAAAAAAAA`]);
      expect(fake.calls).toEqual(["openAdChest"]);
      await vi.waitFor(() => expect(events.find((entry) => entry.event === "ad_reward_claimed")?.payload).toMatchObject({ place: "clad_chest", source: "ad" }));
      expect(useAdChest.getState().stage).toEqual({ kind: "gone" });
      // Второе нажатие ничего не делает.
      await useAdChest.getState().watch();
      expect(fake.calls).toEqual(["openAdChest"]);
      expect(watched).toBe(1);
    });

    it("VIP — без ролика: сессия-пропуск забирается так же, награда помечена пропуском", async () => {
      const fake = await opened({ via: "clad" });
      server.views = [{ ok: true, data: { status: "available", pass: "vip" } }];
      outcomes = [{ kind: "watched", sessionId: "BBBBBBBBBBBBBBBB", source: "pass" }];
      await useAdChest.getState().prepare(input());
      await useAdChest.getState().watch();

      expect(server.asked).toContain(`claim:${RUN_ID}:BBBBBBBBBBBBBBBB`);
      expect(fake.calls).toEqual(["openAdChest"]);
      await vi.waitFor(() => expect(events.find((entry) => entry.event === "ad_reward_claimed")?.payload).toMatchObject({ place: "clad_chest", source: "pass" }));
    });

    it("пока идёт ролик, стадия «смотрим»; закрыл раньше конца — кнопка снова доступна, сундука нет", async () => {
      let finish: (value: AdWatchResult) => void = () => undefined;
      setAdChestDepsForTests({ watch: () => new Promise((resolve) => (finish = resolve)) });
      const fake = await opened({ via: "clad" });
      await useAdChest.getState().prepare(input());

      const watching = useAdChest.getState().watch();
      expect(useAdChest.getState().stage).toEqual({ kind: "watching", pass: false });
      finish({ kind: "closed" });
      await watching;

      expect(useAdChest.getState().stage).toEqual({ kind: "ready", pass: false });
      expect(server.asked).toEqual([`view:${RUN_ID}`]);
      expect(fake.calls).toEqual([]);
    });

    it("ошибка показа — кнопка уходит, «Забрать» закрывает окно как прежде", async () => {
      const fake = await opened({ via: "clad" });
      outcomes = [{ kind: "failed" }];
      await useAdChest.getState().prepare(input());
      await useAdChest.getState().watch();

      expect(useAdChest.getState().stage).toEqual({ kind: "gone" });
      expect(fake.calls).toEqual([]);

      useRun.getState().closeChest();
      expect(fake.calls).toEqual(["closeChest"]);
    });

    it("рекламы нет, место отдыхает, награды закрыты ограничением — кнопка уходит молча", async () => {
      await opened({ via: "clad" });
      for (const outcome of [{ kind: "no_ads" }, { kind: "cooldown", retryAt: null }, { kind: "restricted" }] as AdWatchResult[]) {
        useAdChest.getState().reset();
        outcomes = [outcome];
        await useAdChest.getState().prepare(input());
        await useAdChest.getState().watch();
        expect(useAdChest.getState().stage, outcome.kind).toEqual({ kind: "gone" });
      }
    });

    it("ролик досмотрен, а сервер не ответил — повтор забирает ту же сессию без второго ролика", async () => {
      const fake = await opened({ via: "clad" });
      server.claims = [{ ok: false, failure: "offline" }];
      await useAdChest.getState().prepare(input());

      await useAdChest.getState().watch();
      expect(useAdChest.getState().stage).toEqual({ kind: "ready", pass: false });
      expect(fake.calls).toEqual([]);

      await useAdChest.getState().watch();
      expect(watched).toBe(1);
      expect(server.asked.filter((entry) => entry.startsWith("claim"))).toEqual([`claim:${RUN_ID}:AAAAAAAAAAAAAAAA`, `claim:${RUN_ID}:AAAAAAAAAAAAAAAA`]);
      expect(fake.calls).toEqual(["openAdChest"]);
    });

    it("сервер отказал: сундук уже взят, сессия потрачена, нет забега, не принят досмотр — кнопка уходит, сундука нет", async () => {
      for (const code of ["chest_unavailable", "chest_taken", "run_unverified", "ad_not_completed", "account_restricted"]) {
        const fake = await opened({ via: "clad" });
        server.claims = [{ ok: false, failure: "rejected", code }, { ok: false, failure: "rejected", code }];
        useAdChest.getState().reset();
        await useAdChest.getState().prepare(input());
        await useAdChest.getState().watch();
        expect(useAdChest.getState().stage, code).toEqual({ kind: "gone" });
        expect(fake.calls, code).toEqual([]);
        useRun.getState().stop();
      }
    });

    it("нажатие вне готовой стадии ничего не делает; ответ по ушедшему забегу ничего не меняет", async () => {
      await opened({ via: "clad" });
      await useAdChest.getState().watch();
      expect(watched).toBe(0);

      await useAdChest.getState().prepare(input());
      const late = useAdChest.getState().watch();
      useAdChest.getState().reset();
      await late;
      expect(useAdChest.getState().stage).toEqual({ kind: "idle" });
      expect(server.asked.filter((entry) => entry.startsWith("claim"))).toHaveLength(0);
    });
  });

  describe("смена забега", () => {
    it("«Ещё раз»: готовая кнопка забега A исчезает, нажатие до нового вопроса ничего не забирает и ролика не показывает", async () => {
      const fake = await opened({ via: "clad" });
      await useAdChest.getState().prepare(input());
      expect(useAdChest.getState().stage).toEqual({ kind: "ready", pass: false });

      useRun.getState().restart();
      fake.emit("started", { runId: "run-chest-2", difficultyId: "hard", startingWeaponId: "spark" });
      expect(useAdChest.getState()).toMatchObject({ stage: { kind: "idle" }, runId: null, watched: null });

      await useAdChest.getState().watch();
      expect(watched).toBe(0);
      expect(fake.calls).toEqual([]);
    });
  });

  describe("итог забега", () => {
    const result = (patch: Partial<RunResult>): RunResult =>
      ({
        runId: "run-1",
        difficultyId: "hard",
        outcome: "died",
        survivalSec: 100,
        level: 3,
        enemiesKilled: 10,
        startingWeaponId: "spark",
        weapons: [],
        passives: [],
        contentHash: "abc",
        continues: [],
        killsByEnemy: {},
        damageTaken: 0,
        xpCollected: 0,
        waveReached: 1,
        ...patch,
      }) as unknown as RunResult;

    it("несёт adChests, когда второй сундук взят; без него поля нет", () => {
      expect(toSubmission(result({ adChests: 1 })).adChests).toBe(1);
      expect("adChests" in toSubmission(result({}))).toBe(false);
      expect("adChests" in toSubmission(result({ adChests: 0 }))).toBe(false);
    });
  });
});
