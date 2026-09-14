import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import { createPlaytestApi, PLAYTEST_TIMEOUT_MS } from "../src/state/playtest-api";
import { useMeta } from "../src/state/meta";
import { effectiveAccess, toSubmission, usePlaytest } from "../src/state/playtest";
import { initShell } from "../src/state/shell";

// Отправка итогов забега на сервер плейтеста и разбор его ответов
// (docs/26-stage2-plan.md, WP13).

const QUEUE_KEY = "bh.playtest.v1.pending";

function result(runId: string, patch: Partial<RunResult> = {}): RunResult {
  return {
    runId,
    seed: 7,
    outcome: "died",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "hard",
    contentHash: "abcd1234",
    waveReached: 3,
    survivalSec: 184.5,
    level: 9,
    xpCollected: 300,
    enemiesKilled: 212,
    killsByEnemy: { swarm_rat: 200 },
    damageDealt: 5000,
    damageTaken: 120,
    weapons: [{ id: "spark", level: 4, damage: 4000 }],
    passives: [{ id: "might", level: 2 }],
    deathCause: "swarm_rat",
    distance: 9000,
    peakEnemies: 80,
    ...patch,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SUBMITTED = { data: { bestSurvivalSec: 184.5, isNewBest: true, rank: 3 } };

describe("клиент API плейтеста", () => {
  it("подписывает запрос данными запуска и разбирает ответ", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => json(200, SUBMITTED));
    const api = createPlaytestApi({ baseUrl: "https://api.example/", devUser: "" }, () => "query_id=1&hash=ab", fetch);

    expect(await api.submitRun(toSubmission(result("run-00000001")))).toEqual({ ok: true, data: SUBMITTED.data });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example/api/v1/playtest/runs");
    expect(init?.headers).toMatchObject({ authorization: "tma query_id=1&hash=ab" });
  });

  it("не шлёт запрос, когда игрока нечем подтвердить", async () => {
    const fetch = vi.fn(async () => json(200, SUBMITTED));
    const api = createPlaytestApi({ baseUrl: "", devUser: "" }, () => null, fetch);

    expect(await api.profile()).toEqual({ ok: false, failure: "no_identity" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("кодирует имя разработчика: кириллица в заголовке уронила бы fetch", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => json(404, { error: { code: "disabled" } }));
    const api = createPlaytestApi({ baseUrl: "", devUser: "dev-1:Разработчик" }, () => null, fetch);

    expect(await api.leaderboard("normal")).toEqual({ ok: false, failure: "disabled" });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/playtest/leaderboard?difficulty=normal");
    expect(init?.headers).toMatchObject({ "x-playtest-dev-user": "dev-1%3A%D0%A0%D0%B0%D0%B7%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D1%87%D0%B8%D0%BA" });
  });

  it("переводит ответы в причины: что повторить, а что выбросить", async () => {
    const cases: [Response | Error, string][] = [
      [new TypeError("Failed to fetch"), "offline"],
      [json(401, {}), "unauthorized"],
      [json(400, {}), "rejected"],
      [json(503, {}), "unavailable"],
      [new Response("<html>502</html>", { status: 200 }), "unavailable"],
      [json(200, { data: { rank: "первое" } }), "unavailable"],
    ];
    for (const [reply, failure] of cases) {
      const api = createPlaytestApi({ baseUrl: "", devUser: "" }, () => "signed", async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      });
      expect(await api.submitRun(toSubmission(result("run-00000001"))), failure).toEqual({ ok: false, failure });
    }
  });

  it("обрывает зависший запрос по таймауту", async () => {
    vi.useFakeTimers();
    try {
      const api = createPlaytestApi({ baseUrl: "", devUser: "" }, () => "signed", (_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      });
      const pending = api.profile();
      await vi.advanceTimersByTimeAsync(PLAYTEST_TIMEOUT_MS);
      expect(await pending).toEqual({ ok: false, failure: "offline" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("очередь итогов забега", () => {
  let storage: KeyValueStorage & { values: Record<string, string> };
  let reply: () => Promise<Response>;
  const fetch = vi.fn((..._args: unknown[]) => reply());
  const events: [string, Record<string, unknown>][] = [];

  function mount(withPlaytest = true): void {
    initShell({
      adapter: {
        ui: createNoopPlatformUi(),
        haptic: () => undefined,
        signedLaunchData: () => "signed",
      } as unknown as PlatformAdapter,
      capabilities: {
        platformAvailable: true,
        botUrl: "",
        diagnosticsByDefault: false,
        ...(withPlaytest ? { playtest: { baseUrl: "", devUser: "" } } : {}),
      },
      storage,
      analytics: (event, payload) => events.push([event, payload]),
      build: { version: "test", contentHash: "", platform: "web" },
    });
    usePlaytest.setState({ pending: 0, lastSubmitted: null, leaderboards: {}, profile: null, access: null });
    usePlaytest.getState().hydrate();
  }

  beforeEach(() => {
    const values: Record<string, string> = {};
    storage = {
      values,
      get: (key) => values[key] ?? null,
      set: (key, value) => {
        values[key] = value;
      },
      remove: (key) => {
        delete values[key];
      },
    };
    fetch.mockClear();
    events.length = 0;
    vi.stubGlobal("fetch", fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("отправляет итог сразу и запоминает место для экрана смерти", async () => {
    reply = async () => json(200, SUBMITTED);
    mount();

    usePlaytest.getState().submitRun(result("run-00000001"));
    await vi.waitFor(() => expect(usePlaytest.getState().lastSubmitted?.result.rank).toBe(3));

    expect(usePlaytest.getState().pending).toBe(0);
    expect(storage.values[QUEUE_KEY]).toBe("[]");
    expect(events).toContainEqual(["playtest_run_synced", expect.objectContaining({ result: "sent", trigger: "finish" })]);
  });

  it("без сети держит забег на устройстве и отправляет при следующем запуске", async () => {
    reply = async () => {
      throw new TypeError("Failed to fetch");
    };
    mount();
    usePlaytest.getState().submitRun(result("run-00000001"));
    await vi.waitFor(() => expect(events.map(([event]) => event)).toContain("playtest_run_synced"));
    expect(usePlaytest.getState().pending).toBe(1);

    // «Перезапуск» с появившейся сетью.
    reply = async () => json(200, SUBMITTED);
    mount();
    expect(usePlaytest.getState().pending).toBe(1);
    await usePlaytest.getState().flush("launch");

    expect(usePlaytest.getState().pending).toBe(0);
    const body = JSON.parse(String((fetch.mock.calls.at(-1)?.[1] as RequestInit).body)) as Record<string, unknown>;
    // На сервер уходит только нужное лидерборду: без урона и убийств по врагам.
    expect(body).toEqual({
      runId: "run-00000001",
      difficultyId: "hard",
      outcome: "died",
      survivalSec: 184.5,
      level: 9,
      enemiesKilled: 212,
      startingWeaponId: "spark",
      weapons: [{ id: "spark", level: 4 }],
      contentHash: "abcd1234",
    });
  });

  it("выбрасывает забег, который сервер отверг, и не держит им остальные", async () => {
    let call = 0;
    reply = async () => (++call === 1 ? json(400, {}) : json(200, SUBMITTED));
    mount();
    storage.set(
      QUEUE_KEY,
      JSON.stringify([toSubmission(result("run-00000001")), toSubmission(result("run-00000002"))]),
    );

    await usePlaytest.getState().flush("launch");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(usePlaytest.getState().lastSubmitted?.runId).toBe("run-00000002");
    const synced = events.filter(([event]) => event === "playtest_run_synced");
    expect(synced.map(([, payload]) => payload.result)).toEqual(["dropped", "sent"]);
    expect(events.map(([event]) => event)).toContain("client_error");
  });

  it("хранит не больше двадцати неотправленных забегов — старые уходят первыми", async () => {
    reply = async () => json(503, {});
    mount();
    for (let i = 0; i < 25; i++) usePlaytest.getState().submitRun(result(`run-${String(i).padStart(8, "0")}`));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const queue = JSON.parse(storage.values[QUEUE_KEY] ?? "[]") as { runId: string }[];
    expect(queue).toHaveLength(20);
    expect(queue[0]?.runId).toBe("run-00000005");
  });

  it("рекорд с другого устройства приходит в лобби и в хранилище устройства", async () => {
    reply = async () =>
      json(200, {
        data: {
          runs: 12,
          totalKills: 900,
          totalSurvivalSec: 3000,
          best: { easy: null, normal: { survivalSec: 420, rank: 2 }, hard: null },
          recent: [],
        },
      });
    mount();
    storage.set("bh.meta.v1.bestSurvivalSec.normal", "300");
    useMeta.getState().hydrate();

    expect(await usePlaytest.getState().loadProfile()).toBeNull();
    expect(useMeta.getState().best.normal).toBe(420);
    expect(useMeta.getState().runs).toBe(12);
    expect(storage.values["bh.meta.v1.bestSurvivalSec.normal"]).toBe("420");
  });

  it("инструменты команды открывает сервер, а в dev-сборке они открыты без него", async () => {
    reply = async () => json(200, { data: { admin: false, stressTest: true, devMode: false } });
    mount();
    expect(effectiveAccess(usePlaytest.getState().access, false).stressTest).toBe(false);

    expect(await usePlaytest.getState().loadAccess()).toBeNull();
    expect(effectiveAccess(usePlaytest.getState().access, false)).toEqual({ admin: false, stressTest: true, devMode: false });
    expect(effectiveAccess(null, true).devMode).toBe(true);
  });

  it("сборка без бэкенда плейтеста ничего не копит и не отправляет", async () => {
    reply = async () => json(200, SUBMITTED);
    mount(false);
    usePlaytest.getState().submitRun(result("run-00000001"));
    await usePlaytest.getState().flush("launch");

    expect(fetch).not.toHaveBeenCalled();
    expect(storage.values[QUEUE_KEY]).toBeUndefined();
    expect(await usePlaytest.getState().loadLeaderboard("easy")).toBe("disabled");
  });
});
