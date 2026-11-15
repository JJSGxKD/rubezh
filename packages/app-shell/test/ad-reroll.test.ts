import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunSession, RunSnapshot } from "@bh/core-game";
import type { AdWatchResult } from "../src/state/ad-watch";
import type { AdRerollApi, AdRerollView } from "../src/state/ad-reroll";
import type { ApiResult } from "../src/state/api-request";

// Переброс карточек за рекламу на выборе улучшения (tasks/T-0199, Р133).
// Проверяется то, где он обычно ломается: переброс по ответу SDK, а не сервера;
// второй ролик после потерянного ответа; вопрос серверу, когда кнопки быть не
// может; и кнопка, которая мигает или пережила забег.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { useRun } = await import("../src/state/run");
const { useMeta } = await import("../src/state/meta");
const { initShell } = await import("../src/state/shell");
const { setAdRerollDepsForTests, useAdReroll } = await import("../src/state/ad-reroll");

const RUN_ID = "run-reroll-1";
const NO_CHARGES = { reroll: 0, skip: 0, banish: 0 };

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
    chooseUpgrade: () => calls.push("choose"),
    rerollOffers: () => calls.push("reroll"),
    rerollOffersViaAd: () => calls.push("rerollViaAd"),
    restart: () => undefined,
    abandon: () => undefined,
    snapshot: () => null,
    destroy: () => undefined,
  } as unknown as RunSession;
  const fake: RunEngine = { start: () => session };
  return { engine: fake, emit, calls };
}

/** Сервер в памяти: ответы задаёт тест, запросы он же и видит. */
class FakeServer implements AdRerollApi {
  views: ApiResult<AdRerollView>[] = [];
  claims: ApiResult<{ granted: boolean }>[] = [];
  readonly asked: string[] = [];

  async view(runId: string): Promise<ApiResult<AdRerollView>> {
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

const offer = (id: string) => ({ id, kind: "weapon_new" as const, refId: id, level: 1, nameKey: "n", descriptionKey: "d", changes: [] });

/** Забег идёт, движок прислал выбор улучшения: зарядов нет, переброс за рекламу возможен. */
async function choosing(patch: { canAdReroll?: boolean; tools?: typeof NO_CHARGES; refreshed?: boolean; level?: number } = {}): Promise<ReturnType<typeof fakeEngine>> {
  const fake = fakeEngine();
  engine.load.mockResolvedValue(fake.engine);
  await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "hard" });
  fake.emit("started", { runId: RUN_ID, difficultyId: "hard", startingWeaponId: "spark" });
  levelUp(fake, patch);
  return fake;
}

function levelUp(fake: ReturnType<typeof fakeEngine>, patch: { canAdReroll?: boolean; tools?: typeof NO_CHARGES; refreshed?: boolean; level?: number } = {}): void {
  const tools = patch.tools ?? NO_CHARGES;
  fake.emit("levelUp", {
    level: patch.level ?? 5,
    options: [offer("a"), offer("b"), offer("c")],
    queued: 0,
    tools,
    toolsTotal: tools,
    canReroll: false,
    canAdReroll: patch.canAdReroll ?? true,
    refreshed: patch.refreshed ?? false,
  });
}

/** То, что передаёт экран: забег, остаток зарядов переброса и то, что сказал движок. */
function input(patch: Partial<{ runId: string; reroll: number; canAdReroll: boolean }> = {}) {
  return { runId: RUN_ID, reroll: 0, canAdReroll: true, ...patch };
}

describe("переброс за рекламу в оболочке", () => {
  beforeEach(() => {
    engine.load.mockReset();
    server = new FakeServer();
    outcomes = [];
    watched = 0;
    playable = true;
    events = [];
    setAdRerollDepsForTests({
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
    useAdReroll.getState().reset();
  });

  afterEach(() => {
    useAdReroll.getState().reset();
    useRun.getState().stop();
  });

  describe("вопрос серверу", () => {
    it("заряды ещё есть, движок не обещал переброса или площадка не показывает ролики — сервер не спрашивается", async () => {
      await useAdReroll.getState().prepare(input({ reroll: 1 }));
      await useAdReroll.getState().prepare(input({ canAdReroll: false }));
      playable = false;
      await useAdReroll.getState().prepare(input());

      expect(server.asked).toEqual([]);
      expect(useAdReroll.getState().stage).toEqual({ kind: "idle" });
    });

    it("«можно» — кнопка готова; без ролика у VIP — с пометкой пропуска", async () => {
      await useAdReroll.getState().prepare(input());
      expect(server.asked).toEqual([`view:${RUN_ID}`]);
      expect(useAdReroll.getState().stage).toEqual({ kind: "ready", pass: false });

      useAdReroll.getState().reset();
      server.views = [{ ok: true, data: { status: "available", pass: "vip" } }];
      await useAdReroll.getState().prepare(input());
      expect(useAdReroll.getState().stage).toEqual({ kind: "ready", pass: true });
    });

    it("пока сервер отвечает, кнопки нет: стадия «проверяем»", async () => {
      let release: (value: ApiResult<AdRerollView>) => void = () => undefined;
      let asked = 0;
      server.view = () => {
        asked++;
        return new Promise((resolve) => (release = resolve));
      };
      const asking = useAdReroll.getState().prepare(input());
      expect(useAdReroll.getState().stage).toEqual({ kind: "checking" });
      // Перед вопросом оболочка отправляет очередь забегов: до сервера дело доходит не сразу.
      await vi.waitFor(() => expect(asked).toBe(1));
      release({ ok: true, data: { status: "available", pass: null } });
      await asking;
      expect(useAdReroll.getState().stage).toEqual({ kind: "ready", pass: false });
    });

    it("любая причина «недоступно» закрывает стадию до конца забега: повторного вопроса нет", async () => {
      for (const reason of ["unverified", "finished", "used_up", "no_ads"]) {
        useAdReroll.getState().reset();
        server.asked.length = 0;
        server.views = [{ ok: true, data: { status: "unavailable", reason } }];
        await useAdReroll.getState().prepare(input());
        expect(useAdReroll.getState().stage, reason).toEqual({ kind: "gone" });
        await useAdReroll.getState().prepare(input());
        expect(server.asked, reason).toEqual([`view:${RUN_ID}`]);
      }
    });

    it("связи нет — рекламу не предлагаем: ролик без сервера не засчитать", async () => {
      server.views = [{ ok: false, failure: "offline" }];
      await useAdReroll.getState().prepare(input());
      expect(useAdReroll.getState().stage).toEqual({ kind: "gone" });
    });

    it("сервер не видел старта — одна пауза и второй вопрос", async () => {
      server.views = [{ ok: false, failure: "rejected", code: "run_unverified" }];
      await useAdReroll.getState().prepare(input());
      expect(server.asked).toEqual([`view:${RUN_ID}`, `view:${RUN_ID}`]);
      expect(useAdReroll.getState().stage).toEqual({ kind: "ready", pass: false });

      useAdReroll.getState().reset();
      server.asked.length = 0;
      server.views = [
        { ok: false, failure: "rejected", code: "run_unverified" },
        { ok: false, failure: "rejected", code: "run_unverified" },
      ];
      await useAdReroll.getState().prepare(input());
      expect(server.asked).toHaveLength(2);
      expect(useAdReroll.getState().stage).toEqual({ kind: "gone" });
    });

    it("один вопрос на забег: повторный prepare того же забега ничего не спрашивает; смена забега сбрасывает стор", async () => {
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().prepare(input());
      expect(server.asked).toEqual([`view:${RUN_ID}`]);

      outcomes = [{ kind: "closed" }];
      await useAdReroll.getState().watch();
      expect(useAdReroll.getState().notice).toBe("closed");

      await useAdReroll.getState().prepare(input({ runId: "run-reroll-2" }));
      expect(server.asked).toEqual([`view:${RUN_ID}`, "view:run-reroll-2"]);
      expect(useAdReroll.getState()).toMatchObject({ runId: "run-reroll-2", stage: { kind: "ready", pass: false }, notice: null, watched: null });
    });

    it("ответ по ушедшему забегу ничего не меняет", async () => {
      let release: (value: ApiResult<AdRerollView>) => void = () => undefined;
      let asked = 0;
      server.view = () => {
        asked++;
        return new Promise((resolve) => (release = resolve));
      };
      const asking = useAdReroll.getState().prepare(input());
      await vi.waitFor(() => expect(asked).toBe(1));
      useAdReroll.getState().reset();
      release({ ok: true, data: { status: "available", pass: null } });
      await asking;
      expect(useAdReroll.getState().stage).toEqual({ kind: "idle" });
    });
  });

  describe("нажатие", () => {
    it("досмотр — переброс по ответу сервера, один раз; награда отмечается местом card_reroll; кнопка до конца забега уходит", async () => {
      const fake = await choosing();
      await useAdReroll.getState().prepare(input());
      expect(useAdReroll.getState().stage).toEqual({ kind: "ready", pass: false });

      await useAdReroll.getState().watch();

      expect(server.asked).toEqual([`view:${RUN_ID}`, `claim:${RUN_ID}:AAAAAAAAAAAAAAAA`]);
      expect(fake.calls).toEqual(["rerollViaAd"]);
      await vi.waitFor(() => expect(events.find((entry) => entry.event === "ad_reward_claimed")?.payload).toMatchObject({ place: "card_reroll", source: "ad" }));
      expect(useAdReroll.getState().stage).toEqual({ kind: "gone" });
      // Второе нажатие уже ничего не делает.
      await useAdReroll.getState().watch();
      expect(fake.calls).toEqual(["rerollViaAd"]);
      expect(watched).toBe(1);
    });

    it("VIP — без ролика: сессия-пропуск забирается так же, награда помечена пропуском", async () => {
      const fake = await choosing();
      server.views = [{ ok: true, data: { status: "available", pass: "vip" } }];
      outcomes = [{ kind: "watched", sessionId: "BBBBBBBBBBBBBBBB", source: "pass" }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();

      expect(server.asked).toContain(`claim:${RUN_ID}:BBBBBBBBBBBBBBBB`);
      expect(fake.calls).toEqual(["rerollViaAd"]);
      await vi.waitFor(() => expect(events.find((entry) => entry.event === "ad_reward_claimed")?.payload).toMatchObject({ place: "card_reroll", source: "pass" }));
    });

    it("пока идёт ролик, стадия «смотрим»; закрыл раньше конца — строка и кнопка снова доступна", async () => {
      const fake = await choosing();
      outcomes = [{ kind: "closed" }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();

      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "ready", pass: false }, notice: "closed" });
      expect(server.asked).toEqual([`view:${RUN_ID}`]);
      expect(fake.calls).toEqual([]);
    });

    it("реклама не загрузилась — строка, кнопка остаётся", async () => {
      await choosing();
      outcomes = [{ kind: "failed" }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();
      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "ready", pass: false }, notice: "failed" });
    });

    it("рекламы нет и место отдыхает — кнопка уходит молча; награды закрыты ограничением — строка и уход", async () => {
      await choosing();
      outcomes = [{ kind: "no_ads" }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();
      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "gone" }, notice: null });

      useAdReroll.getState().reset();
      outcomes = [{ kind: "cooldown", retryAt: null }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();
      expect(useAdReroll.getState().stage).toEqual({ kind: "gone" });

      useAdReroll.getState().reset();
      outcomes = [{ kind: "restricted" }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();
      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "gone" }, notice: "restricted" });
    });

    it("ролик досмотрен, а сервер не ответил — повтор забирает ту же сессию без второго ролика", async () => {
      const fake = await choosing();
      server.claims = [{ ok: false, failure: "offline" }];
      await useAdReroll.getState().prepare(input());

      await useAdReroll.getState().watch();
      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "ready", pass: false }, notice: "claim_failed" });
      expect(fake.calls).toEqual([]);

      await useAdReroll.getState().watch();
      expect(watched).toBe(1);
      expect(server.asked.filter((entry) => entry.startsWith("claim"))).toEqual([`claim:${RUN_ID}:AAAAAAAAAAAAAAAA`, `claim:${RUN_ID}:AAAAAAAAAAAAAAAA`]);
      expect(fake.calls).toEqual(["rerollViaAd"]);
    });

    it("сервер не принял досмотр (ad_not_completed) — «не загрузилась», сессия сброшена: следующее нажатие — новый ролик", async () => {
      await choosing();
      server.claims = [{ ok: false, failure: "rejected", code: "ad_not_completed" }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();
      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "ready", pass: false }, notice: "failed", watched: null });
    });

    it("reroll_unavailable, reroll_taken и run_unverified после повтора — кнопка уходит, переброса нет", async () => {
      for (const code of ["reroll_unavailable", "reroll_taken", "run_unverified"]) {
        const fake = await choosing();
        server.claims = [{ ok: false, failure: "rejected", code }, { ok: false, failure: "rejected", code }];
        useAdReroll.getState().reset();
        await useAdReroll.getState().prepare(input());
        await useAdReroll.getState().watch();
        expect(useAdReroll.getState().stage, code).toEqual({ kind: "gone" });
        expect(fake.calls, code).toEqual([]);
        useRun.getState().stop();
      }
    });

    it("ограничение наложили между выдачей и забором — строка про закрытые награды", async () => {
      await choosing();
      server.claims = [{ ok: false, failure: "disabled", code: "account_restricted" }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();
      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "gone" }, notice: "restricted" });
    });

    it("нажатие вне готовой стадии ничего не делает; ответ по ушедшему забегу ничего не меняет", async () => {
      await choosing();
      await useAdReroll.getState().watch();
      expect(watched).toBe(0);

      await useAdReroll.getState().prepare(input());
      const late = useAdReroll.getState().watch();
      useAdReroll.getState().reset();
      await late;
      expect(useAdReroll.getState().stage).toEqual({ kind: "idle" });
      expect(server.asked.filter((entry) => entry.startsWith("claim"))).toHaveLength(0);
    });
  });

  describe("аналитика: card_reroll_ad_offered", () => {
    it("раз на экран нового выбора: тот же выбор после изгнания не шлёт, новый — шлёт; у VIP — pass: true", async () => {
      await choosing();
      await useAdReroll.getState().prepare(input());
      const offered = () => events.filter((entry) => entry.event === "card_reroll_ad_offered");

      useAdReroll.getState().reportOffered({ seq: 1, level: 5 });
      useAdReroll.getState().reportOffered({ seq: 1, level: 5 });
      expect(offered()).toHaveLength(1);
      expect(offered()[0]?.payload).toEqual({ level: 5, pass: false });

      useAdReroll.getState().reportOffered({ seq: 2, level: 6 });
      expect(offered()).toHaveLength(2);
      expect(offered()[1]?.payload).toEqual({ level: 6, pass: false });

      useAdReroll.getState().reset();
      server.views = [{ ok: true, data: { status: "available", pass: "vip" } }];
      await useAdReroll.getState().prepare(input());
      useAdReroll.getState().reportOffered({ seq: 3, level: 7 });
      expect(offered()[2]?.payload).toEqual({ level: 7, pass: true });
    });

    it("без готовой кнопки событие не шлётся", async () => {
      await choosing();
      useAdReroll.getState().reportOffered({ seq: 1, level: 5 });
      server.views = [{ ok: true, data: { status: "unavailable", reason: "no_ads" } }];
      await useAdReroll.getState().prepare(input());
      useAdReroll.getState().reportOffered({ seq: 2, level: 6 });
      expect(events.filter((entry) => entry.event === "card_reroll_ad_offered")).toEqual([]);
    });
  });

  describe("смена забега", () => {
    const NEXT_RUN_ID = "run-reroll-2";
    const started = { runId: NEXT_RUN_ID, difficultyId: "hard" as const, startingWeaponId: "spark" };

    it("«Ещё раз» не размонтирует экран, но заметка забега A не показывается на выборе с тем же номером в забеге B", async () => {
      const fake = await choosing();
      outcomes = [{ kind: "closed" }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();
      const seqA = useRun.getState().offerSeq;
      expect(useAdReroll.getState()).toMatchObject({ notice: "closed", noticeSeq: seqA });

      useRun.getState().restart();
      // Сразу после рестарта, до того как экран что-то перерисует: от забега A не осталось ничего.
      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "idle" }, notice: null, noticeSeq: null, runId: null, watched: null, offeredSeq: null });

      fake.emit("started", started);
      levelUp(fake);
      // Номера выбора в двух забегах совпали: именно это раньше выдавало чужую заметку.
      expect(useRun.getState().offerSeq).toBe(seqA);
      const { notice, noticeSeq } = useAdReroll.getState();
      expect(noticeSeq === useRun.getState().offerSeq ? notice : null).toBeNull();
    });

    it("в новом забеге заряды есть, prepare не зовётся — стор всё равно чист", async () => {
      const fake = await choosing();
      outcomes = [{ kind: "failed" }];
      await useAdReroll.getState().prepare(input());
      await useAdReroll.getState().watch();
      expect(useAdReroll.getState().notice).toBe("failed");

      useRun.getState().restart();
      fake.emit("started", started);
      levelUp(fake, { tools: { reroll: 1, skip: 1, banish: 1 }, canAdReroll: false });
      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "idle" }, notice: null, runId: null });
    });

    it("готовая кнопка забега A исчезает при рестарте: нажатие до нового вопроса ничего не забирает и ролика не показывает", async () => {
      const fake = await choosing();
      await useAdReroll.getState().prepare(input());
      expect(useAdReroll.getState().stage).toEqual({ kind: "ready", pass: false });

      useRun.getState().restart();
      fake.emit("started", started);
      await useAdReroll.getState().watch();

      expect(watched).toBe(0);
      expect(server.asked.filter((entry) => entry.startsWith("claim"))).toEqual([]);
      expect(fake.calls).toEqual([]);
    });

    it("забег B спрашивает сервер о себе, а сброс на смену забега не трогает уже закреплённый за ним стор", async () => {
      const fake = await choosing();
      await useAdReroll.getState().prepare(input());

      useRun.getState().restart();
      fake.emit("started", started);
      levelUp(fake);
      await useAdReroll.getState().prepare(input({ runId: NEXT_RUN_ID }));
      expect(server.asked).toEqual([`view:${RUN_ID}`, `view:${NEXT_RUN_ID}`]);
      expect(useAdReroll.getState()).toMatchObject({ runId: NEXT_RUN_ID, stage: { kind: "ready", pass: false } });

      // Обновление карточек и новый выбор забега не сбрасывают кнопку: id забега прежний.
      levelUp(fake, { refreshed: true });
      levelUp(fake, { level: 6 });
      expect(useAdReroll.getState()).toMatchObject({ runId: NEXT_RUN_ID, stage: { kind: "ready", pass: false } });
    });

    it("выход с экрана забега тоже сбрасывает стор: ответ сервера по ушедшему забегу ничего не меняет", async () => {
      await choosing();
      let release: (value: ApiResult<AdRerollView>) => void = () => undefined;
      let asked = 0;
      server.view = () => {
        asked++;
        return new Promise((resolve) => (release = resolve));
      };
      const asking = useAdReroll.getState().prepare(input());
      await vi.waitFor(() => expect(asked).toBe(1));

      useRun.getState().stop();
      expect(useAdReroll.getState()).toMatchObject({ stage: { kind: "idle" }, runId: null });
      release({ ok: true, data: { status: "available", pass: null } });
      await asking;
      expect(useAdReroll.getState().stage).toEqual({ kind: "idle" });
    });
  });

  describe("стор забега", () => {
    it("запоминает забег из started и несёт canAdReroll из выбора; новый выбор считается, обновление карточек — нет", async () => {
      const fake = await choosing();
      expect(useRun.getState()).toMatchObject({ runId: RUN_ID, phase: "levelUp", canAdReroll: true });
      const seq = useRun.getState().offerSeq;

      levelUp(fake, { refreshed: true });
      expect(useRun.getState().offerSeq).toBe(seq);
      levelUp(fake, { canAdReroll: false, level: 6 });
      expect(useRun.getState().offerSeq).toBe(seq + 1);
      expect(useRun.getState().canAdReroll).toBe(false);
    });

    it("продолженный забег берёт id из сохранения", async () => {
      const fake = fakeEngine();
      engine.load.mockResolvedValue(fake.engine);
      const resume = {
        format: 1,
        contentHash: "abc",
        runId: "run-saved-7",
        seed: 7,
        mapId: "frontier",
        difficultyId: "hard",
        startingWeaponId: "spark",
        summary: { survivalSec: 30, level: 2, weapons: [], passives: [] },
        world: {},
      } as unknown as RunSnapshot;
      await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "hard", resume });
      expect(useRun.getState().runId).toBe("run-saved-7");
    });

    it("rerollViaAd — только на выборе улучшения: движку уходит одна команда", async () => {
      const fake = await choosing();
      useRun.getState().rerollViaAd();
      expect(fake.calls).toEqual(["rerollViaAd"]);

      const idle = fakeEngine();
      useRun.getState().stop();
      engine.load.mockResolvedValue(idle.engine);
      await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "hard" });
      useRun.getState().rerollViaAd();
      expect(idle.calls).toEqual([]);
    });

    it("card_rerolled с via: ad у рекламного переброса; у обычного поля via нет", async () => {
      const fake = await choosing();
      fake.emit("cardTool", { kind: "reroll", left: 1, level: 5 });
      fake.emit("cardTool", { kind: "reroll", left: 0, level: 6, viaAd: true });

      const rerolled = events.filter((entry) => entry.event === "card_rerolled");
      expect(rerolled).toHaveLength(2);
      expect(rerolled[0]?.payload).toEqual({ level: 5, left: 1 });
      expect(rerolled[1]?.payload).toEqual({ level: 6, left: 0, via: "ad" });
    });
  });
});

describe("итог забега с рекламным перебросом", () => {
  function result(patch: Partial<RunResult> = {}): RunResult {
    return {
      runId: RUN_ID,
      seed: 42,
      outcome: "died",
      startingWeaponId: "spark",
      mapId: "frontier",
      difficultyId: "hard",
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
      noHitSec: 0,
      noKillSec: 0,
      killsByElement: {},
      bossKills: 0,
      eliteKills: 0,
      chestsOpened: 0,
      rareChestsOpened: 0,
      crystalsCollected: 0,
      weapons: [{ id: "spark", level: 5, damage: 8000 }],
      passives: [],
      deathCause: "swarm_rat",
      distance: 10_000,
      peakEnemies: 90,
      cheats: false,
      continues: [],
      ...patch,
    };
  }

  it("тело отправки несёт adRerolls, только если переброс был: сервер сверит его с показом", async () => {
    const { toSubmission } = await import("../src/state/runs");
    expect(toSubmission(result({ adRerolls: 1 }), false)).toMatchObject({ adRerolls: 1 });
    expect("adRerolls" in toSubmission(result(), false)).toBe(false);
    expect("adRerolls" in toSubmission(result({ adRerolls: 0 }), false)).toBe(false);
  });
});
