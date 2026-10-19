import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import { CONTENT_HASH, RUN_SNAPSHOT_FORMAT } from "@bh/core-game";
import { useDevMode } from "../src/state/dev-mode";
import { useMeta } from "../src/state/meta";
import { useNavigation } from "../src/state/navigation";
import { SETTLE_MAX_AGE_MS, settleInterruptedRun, useInterruptedNotice } from "../src/state/run-interrupted";
import { toSubmission, useRuns } from "../src/state/runs";
import { resetSessionForTests } from "../src/state/session";
import { initShell } from "../src/state/shell";

// Забег, прерванный обновлением игры, засчитывается (tasks/T-0163): сохранение
// другой сборки не стирается молча, а уходит в очередь итогов как брошенный
// забег. Хранилище в памяти, очередь итогов настоящая, сеть подменена.

const SAVE_KEY = "bh.run.v1.save";
const QUEUE_KEY = "bh.runs.v1.pending";
const DAY_MS = 24 * 3600 * 1000;

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

/** Сохранение забега чужой сборки: хэш другой, счётчиков в `summary` нет, убийства — в теле мира. */
function savedRun(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: RUN_SNAPSHOT_FORMAT,
    contentHash: "other-build",
    runId: "run-interrupt-1",
    seed: 5,
    mapId: "frontier",
    difficultyId: "hard",
    startingWeaponId: "spark",
    summary: { survivalSec: 184.5, level: 9, weapons: [{ id: "spark", level: 4 }], passives: [{ id: "might", level: 2 }] },
    world: { version: 7, stats: { scalars: { enemiesKilled: 41, xpCollected: 300 }, arrays: {} } },
    savedAt: Date.now() - 1000,
    ...patch,
  };
}

describe("забег, прерванный обновлением", () => {
  let storage: KeyValueStorage & { values: Record<string, string> };
  let reply: (url: string) => Promise<Response>;
  const requests: { url: string; body: unknown }[] = [];
  const events: [string, Record<string, unknown>][] = [];

  function mount(withAuth = true): void {
    initShell({
      adapter: {
        ui: createNoopPlatformUi(),
        haptic: () => undefined,
        signedLaunchData: () => "signed",
        clientInfo: () => ({ platform: "android", version: "8.0" }),
      } as unknown as PlatformAdapter,
      capabilities: {
        platformAvailable: true,
        botUrl: "",
        diagnosticsByDefault: false,
        ...(withAuth ? { auth: { baseUrl: "" } } : {}),
      },
      storage,
      analytics: (event, payload) => events.push([event, payload]),
      build: { version: "test", contentHash: CONTENT_HASH, platform: "web" },
    });
    useRuns.setState({ pending: 0, lastSubmitted: null, leaderboards: {}, profile: null });
    useRuns.getState().hydrate();
  }

  /** Что осталось в хранилище сохранения: стирание пишет `null`, а не убирает ключ. */
  function saveLeft(): unknown {
    return JSON.parse(storage.get(SAVE_KEY) ?? "null");
  }

  function put(record: Record<string, unknown>): void {
    storage.set(SAVE_KEY, JSON.stringify(record));
  }

  /** Итоги в очереди на отправку: поле `kind` — служебное. */
  function queued(): Record<string, unknown>[] {
    const raw = storage.get(QUEUE_KEY);
    return raw === null ? [] : (JSON.parse(raw) as Record<string, unknown>[]).filter((entry) => entry.kind === "finish");
  }

  function abandonedEvents(): Record<string, unknown>[] {
    return events.filter(([event]) => event === "run_abandoned").map(([, payload]) => payload);
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
    // Без сети по умолчанию: запись остаётся в очереди, и её можно прочитать.
    reply = async () => {
      throw new TypeError("Failed to fetch");
    };
    resetSessionForTests();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url === "/api/v1/auth/telegram") return json(200, SESSION);
      requests.push({ url, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
      return await reply(url);
    });
    useMeta.setState({ runs: 0, best: { easy: 0, normal: 0, hard: 0 }, lastRun: null });
    useInterruptedNotice.getState().dismiss();
    useNavigation.setState({ stack: ["lobby"] });
    useDevMode.getState().update((settings) => ({ ...settings, countInRating: false }));
    mount();
  });

  afterEach(() => {
    useInterruptedNotice.getState().dismiss();
    vi.unstubAllGlobals();
  });

  it("сохранение другой сборки уходит брошенным забегом с временем и уровнем из сохранения", () => {
    put(savedRun());
    settleInterruptedRun();

    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({
      kind: "finish",
      runId: "run-interrupt-1",
      difficultyId: "hard",
      outcome: "abandoned",
      survivalSec: 184.5,
      level: 9,
      enemiesKilled: 41,
      startingWeaponId: "spark",
      contentHash: "other-build",
      deathCause: null,
      continues: [],
      weapons: [{ id: "spark", level: 4 }],
      passives: [{ id: "might", level: 2 }],
    });
    expect(queued()[0]).not.toHaveProperty("cheats");
    expect(saveLeft()).toBeNull();
  });

  it("другой формат снимка засчитывается так же", () => {
    put(savedRun({ format: RUN_SNAPSHOT_FORMAT - 1, contentHash: CONTENT_HASH }));
    settleInterruptedRun();

    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ outcome: "abandoned", enemiesKilled: 41, contentHash: CONTENT_HASH });
    expect(saveLeft()).toBeNull();
  });

  it("счётчики из summary главнее тела мира, а без счётчика в теле — убийств ноль", () => {
    put(savedRun({ summary: { ...(savedRun().summary as object), enemiesKilled: 12, xpCollected: 55 } }));
    settleInterruptedRun();
    expect(queued()[0]).toMatchObject({ enemiesKilled: 12, stats: { xpCollected: 55 } });

    storage.remove(QUEUE_KEY);
    useRuns.getState().hydrate();
    put(savedRun({ runId: "run-interrupt-2", world: { version: 7 } }));
    settleInterruptedRun();
    expect(queued()[0]).toMatchObject({ runId: "run-interrupt-2", enemiesKilled: 0 });
  });

  it("совместимое сохранение не трогает: ничего не отправлено и не стёрто", () => {
    put(savedRun({ contentHash: CONTENT_HASH }));
    settleInterruptedRun();

    expect(queued()).toHaveLength(0);
    expect(saveLeft()).not.toBeNull();
    expect(useInterruptedNotice.getState().notice).toBeNull();
  });

  it("старше срока стирается без отправки и без карточки, на сутки моложе — засчитывается", () => {
    put(savedRun({ savedAt: Date.now() - SETTLE_MAX_AGE_MS - 1000 }));
    settleInterruptedRun();
    expect(queued()).toHaveLength(0);
    expect(saveLeft()).toBeNull();
    expect(useInterruptedNotice.getState().notice).toBeNull();

    put(savedRun({ savedAt: Date.now() - SETTLE_MAX_AGE_MS + DAY_MS }));
    settleInterruptedRun();
    expect(queued()).toHaveLength(1);
  });

  it("savedAt из будущего считается свежим", () => {
    put(savedRun({ savedAt: Date.now() + 3 * 3600 * 1000 }));
    settleInterruptedRun();

    expect(queued()).toHaveLength(1);
  });

  it("время зажато сутками, уровень — от единицы", () => {
    put(savedRun({ summary: { ...(savedRun().summary as object), survivalSec: 90_000, level: 0 } }));
    settleInterruptedRun();

    expect(queued()[0]).toMatchObject({ survivalSec: 86_400, level: 1 });
  });

  it("повторный вызов подряд не двоит забег", () => {
    put(savedRun());
    settleInterruptedRun();
    settleInterruptedRun();

    expect(queued()).toHaveLength(1);
  });

  it("забег с тем же runId уже в очереди — вторая запись не добавляется", () => {
    const result = { runId: "run-interrupt-1", outcome: "abandoned", difficultyId: "hard", startingWeaponId: "spark", mapId: "frontier", seed: 5, contentHash: "other-build", waveReached: 0, survivalSec: 184.5, level: 9, xpCollected: 0, enemiesKilled: 41, killsByEnemy: {}, damageDealt: 0, damageTaken: 0, damageByElement: {}, weapons: [], passives: [], deathCause: null, distance: 0, peakEnemies: 0, cheats: false, continues: [] } as RunResult;
    storage.set(QUEUE_KEY, JSON.stringify([{ kind: "finish", ...toSubmission(result) }]));
    useRuns.getState().hydrate();

    put(savedRun());
    settleInterruptedRun();

    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ enemiesKilled: 41, survivalSec: 184.5 });
    expect(saveLeft()).toBeNull();
  });

  it("обычный забег: в записи нет cheats, рекорд устройства обновлён", () => {
    put(savedRun());
    settleInterruptedRun();

    expect(queued()[0]).not.toHaveProperty("cheats");
    expect(useMeta.getState().best.hard).toBeGreaterThan(184);
    expect(useMeta.getState().runs).toBe(1);
  });

  it("забег разработчика с читами без просьбы учесть: cheats, countInRating false, рекорд не меняется", () => {
    put(savedRun({ cheats: true, dev: true }));
    settleInterruptedRun();

    expect(queued()[0]).toMatchObject({ cheats: true, countInRating: false });
    expect(useMeta.getState().best.hard).toBe(0);
    expect(useMeta.getState().runs).toBe(0);
  });

  it("забег разработчика с читами и просьбой учесть: countInRating true, рекорд обновлён", () => {
    useDevMode.getState().update((settings) => ({ ...settings, countInRating: true }));
    put(savedRun({ cheats: true, dev: true }));
    settleInterruptedRun();

    expect(queued()[0]).toMatchObject({ cheats: true, countInRating: true });
    expect(useMeta.getState().best.hard).toBeGreaterThan(184);
  });

  it("читы без режима разработчика не дают просьбу учесть, даже если настройка включена", () => {
    useDevMode.getState().update((settings) => ({ ...settings, countInRating: true }));
    put(savedRun({ cheats: true }));
    settleInterruptedRun();

    expect(queued()[0]).toMatchObject({ cheats: true, countInRating: false });
  });

  it("без авторизации в очередь ничего не идёт, сохранение стёрто, рекорд устройства обновлён", () => {
    mount(false);
    put(savedRun());
    settleInterruptedRun();

    expect(storage.get(QUEUE_KEY)).toBeNull();
    expect(saveLeft()).toBeNull();
    expect(useMeta.getState().best.hard).toBeGreaterThan(184);
  });

  it("сервер отверг данные — запись выброшена и не повторяется; сеть и ошибка сервера — запись остаётся", async () => {
    reply = async () => json(400, {});
    put(savedRun());
    settleInterruptedRun();
    await vi.waitFor(() => expect(queued()).toHaveLength(0));
    expect(requests).toHaveLength(1);

    reply = async () => json(500, {});
    requests.length = 0;
    put(savedRun({ runId: "run-interrupt-2" }));
    settleInterruptedRun();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(queued()).toHaveLength(1);
  });

  it("запись уходит на сервер как итог брошенного забега", async () => {
    reply = async () => json(200, FINISHED);
    put(savedRun());
    settleInterruptedRun();

    await vi.waitFor(() => expect(requests.some((request) => request.url === "/api/v1/runs")).toBe(true));
    expect(requests.find((request) => request.url === "/api/v1/runs")?.body).toMatchObject({
      runId: "run-interrupt-1",
      outcome: "abandoned",
      enemiesKilled: 41,
      contentHash: "other-build",
    });
  });

  it("событие run_abandoned с признаком interrupted: update и приблизительными числами", () => {
    put(savedRun());
    settleInterruptedRun();

    expect(abandonedEvents()).toHaveLength(1);
    expect(abandonedEvents()[0]).toMatchObject({
      interrupted: "update",
      wave: 0,
      enemiesKilled: 41,
      survivalSec: 185,
      level: 9,
      weapon: "spark",
      map: "frontier",
      difficulty: "hard",
      contentHash: "other-build",
      cheats: false,
    });
  });

  describe("карточка «Игра обновилась — забег засчитан»", () => {
    it("в памяти лежит время и уровень", () => {
      useNavigation.setState({ stack: ["lobby", "run"] });
      put(savedRun());
      settleInterruptedRun();

      expect(useInterruptedNotice.getState().notice).toEqual({ survivalSec: 184.5, level: 9 });
    });

    it("поверх забега не показывается, в лобби — открывается один раз", () => {
      useNavigation.setState({ stack: ["lobby", "run"] });
      put(savedRun());
      settleInterruptedRun();
      expect(useNavigation.getState().stack).toEqual(["lobby", "run"]);

      useNavigation.setState({ stack: ["lobby"] });
      expect(useNavigation.getState().stack).toEqual(["lobby", "runInterrupted"]);

      useInterruptedNotice.getState().dismiss();
      useNavigation.getState().pop();
      expect(useNavigation.getState().stack).toEqual(["lobby"]);
      expect(useInterruptedNotice.getState().notice).toBeNull();
    });

    it("если игрок уже в лобби — открывается сразу", () => {
      put(savedRun());
      settleInterruptedRun();

      expect(useNavigation.getState().stack).toEqual(["lobby", "runInterrupted"]);
    });

    it("забег не засчитан — карточки нет", () => {
      put(savedRun({ contentHash: CONTENT_HASH }));
      settleInterruptedRun();

      expect(useNavigation.getState().stack).toEqual(["lobby"]);
    });
  });
});
