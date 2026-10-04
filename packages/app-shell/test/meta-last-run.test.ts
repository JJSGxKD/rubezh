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
