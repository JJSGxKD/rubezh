import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, RUN_MODIFIER_REWARD_MUL, type KeyValueStorage, type PlatformAdapter, type RunResult, type RunStartSubmission } from "@bh/shared-types";
import { RUN_MODIFIERS } from "@bh/core-game";
import "../src/i18n/account";
import { t } from "../src/i18n";
import {
  deathModifierLine,
  modifierEventFields,
  modifierIdsOf,
  modifierRewardNote,
  modifierRows,
  rewardMulMark,
  resolveModifierChoice,
} from "../src/state/modifier-choice";
import { useMeta } from "../src/state/meta";
import { toStart, toSubmission } from "../src/state/runs";
import { initShell } from "../src/state/shell";

// Выбор модификатора забега в листе «Перед забегом» (tasks/T-0123, Р105): чистая
// логика без React. Уровень открытия берётся из таблицы разблокировок движка,
// процент награды — из `RUN_MODIFIER_REWARD_MUL`, а не из текста.

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
    runId: "run-00000002",
    seed: 1,
    outcome: "died",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "hard",
    contentHash: "h",
    waveReached: 1,
    survivalSec: 60,
    level: 2,
    xpCollected: 1,
    enemiesKilled: 3,
    killsByEnemy: {},
    damageDealt: 1,
    damageTaken: 1,
    damageByElement: {},
    noHitSec: 0,
    noKillSec: 0,
    killsByElement: {},
    bossKills: 0,
    eliteKills: 0,
    chestsOpened: 0,
    rareChestsOpened: 0,
    crystalsCollected: 0,
    weapons: [],
    passives: [],
    deathCause: null,
    distance: 1,
    peakEnemies: 1,
    cheats: false,
    continues: [],
    ...patch,
  };
}

describe("resolveModifierChoice", () => {
  it("сохранённый открытый модификатор остаётся", () => {
    expect(resolveModifierChoice("hurry", 9)).toBe("hurry");
    expect(resolveModifierChoice("inverse", 12)).toBe("inverse");
  });

  it("закрытый уровнем сбрасывается молча", () => {
    expect(resolveModifierChoice("hurry", 8)).toBeNull();
    expect(resolveModifierChoice("inverse", 9)).toBeNull();
  });

  it("неизвестный id, пустое и отсутствующее — без модификатора", () => {
    expect(resolveModifierChoice("fog", 30)).toBeNull();
    expect(resolveModifierChoice(null, 30)).toBeNull();
    expect(resolveModifierChoice(undefined, 30)).toBeNull();
  });
});

describe("modifierRows", () => {
  it("на 8-м уровне оба закрыты и называют уровни 9 и 12", () => {
    const rows = modifierRows(8);
    expect(rows.map((row) => [row.id, row.locked, row.level])).toEqual([
      ["hurry", true, 9],
      ["inverse", true, 12],
    ]);
  });

  it("на 12-м уровне оба открыты; на 9-м открыта только «Спешка»", () => {
    expect(modifierRows(12).every((row) => !row.locked)).toBe(true);
    expect(modifierRows(9).map((row) => row.locked)).toEqual([false, true]);
  });

  it("список совпадает с контентом: новый модификатор встаёт в лист сам", () => {
    expect(modifierRows(99).map((row) => row.id)).toEqual(RUN_MODIFIERS.map((modifier) => modifier.id));
  });
});

describe("тексты и поля", () => {
  it("подпись награды берёт процент из таблицы множителей", () => {
    const percent = Math.round((RUN_MODIFIER_REWARD_MUL.hurry - 1) * 100);
    expect(modifierRewardNote("hurry")).toBe(t("modifier.reward", { percent }));
    expect(modifierRewardNote("hurry")).toContain(`+${percent}%`);
    expect(modifierRewardNote("hurry")).toContain("в рейтинг не идёт");
  });

  it("выбор превращается в список для движка и старта; «Без» — без поля", () => {
    expect(modifierIdsOf("hurry")).toEqual(["hurry"]);
    expect(modifierIdsOf(null)).toBeUndefined();
  });

  it("поле `modifier` аналитики — первый id; без модификатора поля нет", () => {
    expect(modifierEventFields(["inverse"])).toEqual({ modifier: "inverse" });
    expect(modifierEventFields([])).toEqual({});
    expect(modifierEventFields(undefined)).toEqual({});
  });

  it("экран смерти: строка модификатора есть только при `modifierIds`", () => {
    expect(deathModifierLine(["hurry"])).toBe(t("death.modifier", { name: t("modifier.hurry.name") }));
    expect(deathModifierLine(["hurry"])).toContain("Спешка");
    expect(deathModifierLine(undefined)).toBeNull();
    expect(deathModifierLine([])).toBeNull();
  });

  it("пометка «×1,25» — только когда награда пришла", () => {
    expect(rewardMulMark(["hurry"], "granted")).toBe("×1,25");
    expect(rewardMulMark(["hurry"], "pending")).toBeNull();
    expect(rewardMulMark(["hurry"], "none")).toBeNull();
    expect(rewardMulMark(["hurry"], undefined)).toBeNull();
    expect(rewardMulMark(undefined, "granted")).toBeNull();
  });
});

describe("запоминание выбора", () => {
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

  it("по умолчанию «Без»; выбор переживает перезапуск, «Без» снова стирает его", () => {
    expect(useMeta.getState().lastModifierId).toBeNull();
    useMeta.getState().rememberModifier("hurry");
    useMeta.setState({ lastModifierId: null });
    useMeta.getState().hydrate();
    expect(useMeta.getState().lastModifierId).toBe("hurry");
    useMeta.getState().rememberModifier(null);
    useMeta.getState().hydrate();
    expect(useMeta.getState().lastModifierId).toBeNull();
  });

  it("устаревший или чужой id в хранилище — «Без», профиль не ломается", () => {
    storage.values["bh.meta.v1.profile"] = JSON.stringify({ runs: 2, lastWeaponId: "spark", lastModifierId: "fog" });
    useMeta.getState().hydrate();
    expect(useMeta.getState()).toMatchObject({ runs: 2, lastModifierId: null });
  });
});

describe("старт и итог несут модификатор", () => {
  it("сообщение старта берёт `modifierIds` из записи очереди", () => {
    const entry = { kind: "start" as const, runId: "run-00000001", difficultyId: "hard" as const, startingWeaponId: "spark", contentHash: "h", startedAtMs: 1000, modifierIds: ["hurry" as const] };
    const submission: RunStartSubmission = toStart(entry, 4000);
    expect(submission.modifierIds).toEqual(["hurry"]);
    const without = { ...entry, modifierIds: undefined };
    expect(toStart(without, 4000)).not.toHaveProperty("modifierIds");
  });

  it("итог несёт `modifierIds` результата и не несёт без него", () => {
    expect(toSubmission(result({ modifierIds: ["inverse"] })).modifierIds).toEqual(["inverse"]);
    expect(toSubmission(result())).not.toHaveProperty("modifierIds");
  });
});
