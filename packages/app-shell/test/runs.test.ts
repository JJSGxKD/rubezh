import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import { failureOf, sessionFailure } from "../src/state/api-request";
import { useMeta } from "../src/state/meta";
import { effectiveAccess, usePlaytest } from "../src/state/playtest";
import { toStart, toSubmission, useRuns } from "../src/state/runs";
import { resetSessionForTests } from "../src/state/session";
import { initShell } from "../src/state/shell";

// Забеги под аккаунтом: старт и итог в одной очереди, рейтинг и профиль
// (docs/34-stage3-plan.md, WP4). Сеть подменяется, сессия — настоящая: так
// проверяется та же цепочка, что работает у игрока.

const QUEUE_KEY = "bh.runs.v1.pending";
const LEGACY_QUEUE_KEY = "bh.playtest.v1.pending";

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
    cheats: false,
    ...patch,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SESSION = {
  data: {
    accessToken: "access",
    expiresInSec: 900,
    refreshToken: "refresh-token-refresh-token",
    account: { accountId: "acc", displayName: "Дым", photoUrl: null, createdAt: "2026-09-23T00:00:00.000Z", created: false },
  },
};
const FINISHED = { data: { bestSurvivalSec: 184.5, isNewBest: true, rank: 3, recorded: true, verdict: "ok" } };
const STARTED = { data: { trusted: true } };

describe("очередь забегов", () => {
  let storage: KeyValueStorage & { values: Record<string, string> };
  /** ответ API на всё, кроме входа: вход отвечает сессией сам */
  let reply: (url: string) => Promise<Response>;
  const requests: { url: string; body: unknown }[] = [];
  const events: [string, Record<string, unknown>][] = [];

  function mount(withAuth = true): void {
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
        ...(withAuth ? { auth: { baseUrl: "" } } : {}),
      },
      storage,
      analytics: (event, payload) => events.push([event, payload]),
      build: { version: "test", contentHash: "abcd1234", platform: "web" },
    });
    useRuns.setState({ pending: 0, lastSubmitted: null, leaderboards: {}, profile: null });
    useRuns.getState().hydrate();
  }

  function synced(): Record<string, unknown>[] {
    return events.filter(([event]) => event === "run_synced").map(([, payload]) => payload);
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
    requests.length = 0;
    events.length = 0;
    resetSessionForTests();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url === "/api/v1/auth/telegram") return json(200, SESSION);
      requests.push({ url, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
      return await reply(url);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("старт уходит раньше итога, а место из ответа ждёт экран смерти", async () => {
    reply = async (url) => json(200, url === "/api/v1/runs/start" ? STARTED : FINISHED);
    mount();

    useRuns.getState().registerStart({ runId: "run-00000001", difficultyId: "hard", startingWeaponId: "spark" });
    useRuns.getState().submitRun(result("run-00000001"));
    await vi.waitFor(() => expect(useRuns.getState().lastSubmitted?.result.rank).toBe(3));

    expect(requests.map((request) => request.url)).toEqual(["/api/v1/runs/start", "/api/v1/runs"]);
    expect(useRuns.getState().pending).toBe(0);
    expect(storage.values[QUEUE_KEY]).toBe("[]");
    expect(synced()).toEqual([
      expect.objectContaining({ kind: "start", result: "sent", trusted: true }),
      expect.objectContaining({ kind: "finish", result: "sent", verdict: "ok", rank: 3 }),
    ]);
  });

  it("без сети держит старт и итог на устройстве и отправляет по порядку при следующем запуске", async () => {
    reply = async () => {
      throw new TypeError("Failed to fetch");
    };
    mount();
    useRuns.getState().registerStart({ runId: "run-00000001", difficultyId: "hard", startingWeaponId: "spark" });
    useRuns.getState().submitRun(result("run-00000001"));
    await vi.waitFor(() => expect(synced().length).toBeGreaterThan(0));
    // Игрок видит только забеги: старт — служебная запись.
    expect(useRuns.getState().pending).toBe(1);

    reply = async (url) => json(200, url === "/api/v1/runs/start" ? STARTED : FINISHED);
    requests.length = 0;
    mount();
    await useRuns.getState().flush("launch");

    expect(requests.map((request) => request.url)).toEqual(["/api/v1/runs/start", "/api/v1/runs"]);
    expect(requests[0]?.body).toMatchObject({ runId: "run-00000001", difficultyId: "hard", startingWeaponId: "spark", contentHash: "abcd1234" });
    // На сервер уходит только нужное рейтингу и антифроду: без урона и убийств по врагам.
    expect(requests[1]?.body).toEqual({
      runId: "run-00000001",
      difficultyId: "hard",
      outcome: "died",
      survivalSec: 184.5,
      level: 9,
      enemiesKilled: 212,
      startingWeaponId: "spark",
      weapons: [{ id: "spark", level: 4 }],
      contentHash: "abcd1234",
      deathCause: "swarm_rat",
    });
    expect(useRuns.getState().pending).toBe(0);
  });

  it("отвергнутую запись выбрасывает и не держит ею остальные", async () => {
    let call = 0;
    reply = async () => (++call === 1 ? json(400, {}) : json(200, FINISHED));
    mount();
    storage.set(
      QUEUE_KEY,
      JSON.stringify([
        { kind: "finish", ...toSubmission(result("run-00000001")) },
        { kind: "finish", ...toSubmission(result("run-00000002")) },
      ]),
    );

    await useRuns.getState().flush("launch");

    expect(requests).toHaveLength(2);
    expect(useRuns.getState().lastSubmitted?.runId).toBe("run-00000002");
    expect(synced().map((payload) => payload.result)).toEqual(["dropped", "sent"]);
    expect(events.map(([event]) => event)).toContain("client_error");
  });

  it("непринятый вход держит забег в очереди и говорит, почему", async () => {
    reply = async () => json(200, FINISHED);
    mount();
    vi.stubGlobal("fetch", async () => json(401, { error: { code: "unauthorized", message: "нет" } }));

    useRuns.getState().submitRun(result("run-00000001"));
    await vi.waitFor(() => expect(synced()).toHaveLength(1));

    expect(synced()[0]).toMatchObject({ kind: "finish", result: "queued", failure: "unauthorized" });
    expect(useRuns.getState().pending).toBe(1);
  });

  it("хранит не больше сорока записей — двадцать забегов со стартом, старые уходят первыми", async () => {
    reply = async () => json(503, {});
    mount();
    for (let i = 0; i < 25; i++) {
      const runId = `run-${String(i).padStart(8, "0")}`;
      useRuns.getState().registerStart({ runId, difficultyId: "hard", startingWeaponId: "spark" });
      useRuns.getState().submitRun(result(runId));
    }
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));

    const queue = JSON.parse(storage.values[QUEUE_KEY] ?? "[]") as { kind: string; runId: string }[];
    expect(queue).toHaveLength(40);
    expect(queue[0]).toMatchObject({ kind: "start", runId: "run-00000005" });
    expect(useRuns.getState().pending).toBe(20);
  });

  it("забеги из очереди прошлой сборки переезжают в голову новой, а старый ключ снимается", () => {
    storage.set(LEGACY_QUEUE_KEY, JSON.stringify([toSubmission(result("run-old-0001")), toSubmission(result("run-old-0002"))]));
    storage.set(QUEUE_KEY, JSON.stringify([{ kind: "finish", ...toSubmission(result("run-new-0001")) }]));

    reply = async () => json(503, {});
    mount();

    const queue = JSON.parse(storage.values[QUEUE_KEY] ?? "[]") as { kind: string; runId: string }[];
    expect(queue.map((entry) => entry.runId)).toEqual(["run-old-0001", "run-old-0002", "run-new-0001"]);
    expect(queue.every((entry) => entry.kind === "finish")).toBe(true);
    expect(storage.values[LEGACY_QUEUE_KEY]).toBeUndefined();
    expect(useRuns.getState().pending).toBe(3);
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

    expect(await useRuns.getState().loadProfile()).toBeNull();
    expect(useMeta.getState().best.normal).toBe(420);
    expect(useMeta.getState().runs).toBe(12);
    expect(storage.values["bh.meta.v1.bestSurvivalSec.normal"]).toBe("420");
  });

  it("сборка без авторизации ничего не копит и не отправляет", async () => {
    reply = async () => json(200, FINISHED);
    mount(false);
    useRuns.getState().registerStart({ runId: "run-00000001", difficultyId: "hard", startingWeaponId: "spark" });
    useRuns.getState().submitRun(result("run-00000001"));
    await useRuns.getState().flush("launch");

    expect(requests).toEqual([]);
    expect(storage.values[QUEUE_KEY]).toBeUndefined();
    expect(await useRuns.getState().loadLeaderboard("easy")).toBe("disabled");
  });

  it("инструменты команды открывает сервер, а на dev-сервере — явный VITE_DEV_TOOLS", async () => {
    reply = async () => json(200, { data: { admin: false, stressTest: true, devMode: false } });
    mount();
    usePlaytest.setState({ access: null });
    expect(effectiveAccess(usePlaytest.getState().access, false).stressTest).toBe(false);

    expect(await usePlaytest.getState().loadAccess()).toBeNull();
    expect(requests.at(-1)?.url).toBe("/api/v1/playtest/access");
    expect(effectiveAccess(usePlaytest.getState().access, false)).toEqual({ admin: false, stressTest: true, devMode: false });
    expect(effectiveAccess(null, true)).toEqual({ admin: true, stressTest: true, devMode: true });
    // Без ответа сервера и без явного разрешения не открыто ничего: через
    // туннель к dev-серверу играют тестеры.
    expect(effectiveAccess(null, false)).toEqual({ admin: false, stressTest: false, devMode: false });
  });
});

describe("старт забега для сервера", () => {
  const entry = { kind: "start" as const, runId: "run-1", difficultyId: "hard" as const, startingWeaponId: "spark", contentHash: "abc", startedAtMs: 1_000_000 };

  it("несёт, сколько секунд забег шёл до отправки: старт мог ждать сеть", () => {
    expect(toStart(entry, 1_000_000 + 12_340).elapsedSec).toBe(12.3);
  });

  it("часы устройства, ушедшие назад, не дают отрицательного времени, а старое — не больше суток", () => {
    expect(toStart(entry, 999_000).elapsedSec).toBe(0);
    expect(toStart(entry, 1_000_000 + 3 * 86_400_000).elapsedSec).toBe(86_400);
  });
});

describe("причины неудачи запроса", () => {
  it("коды ответа — в то, что делать: повторить, выбросить или сказать игроку", () => {
    expect(failureOf(401)).toBe("unauthorized");
    expect(failureOf(404)).toBe("disabled");
    expect(failureOf(403)).toBe("disabled");
    expect(failureOf(400)).toBe("rejected");
    expect(failureOf(413)).toBe("rejected");
    expect(failureOf(503)).toBe("unavailable");
  });

  it("без сессии причину знает сессия; заблокированный и непринятый вход одинаковы для запроса", () => {
    expect(sessionFailure("no_identity")).toBe("no_identity");
    expect(sessionFailure("offline")).toBe("offline");
    expect(sessionFailure("banned")).toBe("unauthorized");
    expect(sessionFailure("rejected")).toBe("unauthorized");
    expect(sessionFailure(null)).toBe("disabled");
  });
});
