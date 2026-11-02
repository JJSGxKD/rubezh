import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import { useMeta } from "../src/state/meta";
import { initShell } from "../src/state/shell";

// Последний забег в мете (docs/35-stage4-plan.md WP42, часть 3): виджет
// рекорда говорит, сколько до него не хватило. Забег с читами его не
// трогает, как и рекорд; после перезапуска он на месте.

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

function result(patch: Partial<RunResult> = {}): RunResult {
  return {
    runId: "run-1",
    seed: 7,
    outcome: "died",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "normal",
    contentHash: "abcd1234",
    waveReached: 3,
    survivalSec: 184.5,
    level: 9,
    xpCollected: 300,
    enemiesKilled: 212,
    killsByEnemy: { swarm_rat: 200 },
    damageDealt: 5000,
    damageTaken: 120,
    damageByElement: {},
    noHitSec: 0,
    noKillSec: 0,
    killsByElement: {},
    bossKills: 0,
    eliteKills: 0,
    chestsOpened: 0,
    crystalsCollected: 0,
    weapons: [{ id: "spark", level: 4, damage: 4000 }],
    passives: [{ id: "might", level: 2 }],
    deathCause: "swarm_rat",
    distance: 9000,
    peakEnemies: 80,
    cheats: false,
    continues: [],
    ...patch,
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage,
    analytics: () => undefined,
    build: { version: "test", contentHash: "abc", platform: "telegram" },
  });
  useMeta.getState().hydrate();
});

describe("последний забег", () => {
  it("на устройстве ещё не играли — его нет", () => {
    expect(useMeta.getState().lastRun).toBeNull();
  });

  it("засчитанный забег запоминается со сложностью и переживает перезапуск", () => {
    useMeta.getState().submitRun(result({ survivalSec: 300 }));
    useMeta.getState().submitRun(result({ difficultyId: "hard", survivalSec: 120 }));
    expect(useMeta.getState().lastRun).toEqual({ difficultyId: "hard", survivalSec: 120 });

    useMeta.setState({ lastRun: null });
    useMeta.getState().hydrate();
    expect(useMeta.getState().lastRun).toEqual({ difficultyId: "hard", survivalSec: 120 });
  });

  it("забег с читами — ни рекорда, ни последнего забега", () => {
    useMeta.getState().submitRun(result({ survivalSec: 300 }));
    useMeta.getState().submitRun(result({ survivalSec: 900, cheats: true }));
    expect(useMeta.getState().lastRun).toEqual({ difficultyId: "normal", survivalSec: 300 });
  });

  it("профиль от сборки без поля — читается, последнего забега просто нет", () => {
    storage.values["bh.meta.v1.profile"] = JSON.stringify({ runs: 4, lastWeaponId: "spark" });
    useMeta.getState().hydrate();
    expect(useMeta.getState()).toMatchObject({ runs: 4, lastRun: null });
  });
});

describe("единая сложность и обучающий забег (T-0190, Р126)", () => {
  it("обучающий забег увеличивает счётчик, но не пишет ни рекорд, ни последний забег", () => {
    const isRecord = useMeta.getState().submitRun(result({ difficultyId: "easy", survivalSec: 500 }));

    expect(isRecord).toBe(false);
    const state = useMeta.getState();
    expect(state.runs).toBe(1);
    expect(state.best.easy).toBe(0);
    expect(state.lastRun).toBeNull();

    // Ничего не лежит и в хранилище: после перезапуска всё то же.
    useMeta.getState().hydrate();
    expect(useMeta.getState()).toMatchObject({ runs: 1, lastRun: null, best: { easy: 0, normal: 0, hard: 0 } });
    expect(storage.values["bh.meta.v1.bestSurvivalSec.easy"]).toBeUndefined();
  });

  it("забег единой сложности пишет рекорд и последний забег", () => {
    const isRecord = useMeta.getState().submitRun(result({ difficultyId: "hard", survivalSec: 240 }));

    expect(isRecord).toBe(true);
    expect(useMeta.getState()).toMatchObject({
      runs: 1,
      best: { hard: 240 },
      lastRun: { difficultyId: "hard", survivalSec: 240 },
    });
  });

  it("продолженный забег прежней «Нормальной» засчитывается как раньше", () => {
    expect(useMeta.getState().submitRun(result({ difficultyId: "normal", survivalSec: 90 }))).toBe(true);
    expect(useMeta.getState().best.normal).toBe(90);
  });

  it("обучающий забег с читами не двигает и счётчик", () => {
    useMeta.getState().submitRun(result({ difficultyId: "easy", cheats: true }));
    expect(useMeta.getState().runs).toBe(0);
  });

  it("профиль прежней сборки с lastDifficultyId читается; поля нет ни в сторе, ни в записи", () => {
    storage.values["bh.meta.v1.profile"] = JSON.stringify({ runs: 3, lastWeaponId: "spark", lastDifficultyId: "normal" });

    expect(() => useMeta.getState().hydrate()).not.toThrow();
    expect(useMeta.getState().runs).toBe(3);
    expect("lastDifficultyId" in useMeta.getState()).toBe(false);

    useMeta.getState().rememberWeapon("ember");
    expect(JSON.parse(storage.values["bh.meta.v1.profile"] ?? "{}")).not.toHaveProperty("lastDifficultyId");
  });

  it("рекорд hard прежней сборки сброшен и не возвращается слиянием с сервера", () => {
    storage.values["bh.meta.v1.profile"] = JSON.stringify({ runs: 5, lastWeaponId: "spark", best: { hard: 900 } });
    storage.values["bh.meta.v1.bestSurvivalSec.hard"] = "900";
    useMeta.getState().hydrate();

    expect(useMeta.getState().best.hard).toBe(0);

    useMeta.getState().mergeRemote({ runs: 5, best: { hard: 120 } });
    expect(useMeta.getState().best.hard).toBe(120);
  });
});
