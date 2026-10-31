import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runFinishSchema } from "../src/modules/runs/dto/runs.dto.js";
import { countersOf, countersPlausible, type RunCounters } from "../src/modules/runs/run-counters.js";

/**
 * Серии и убийства по стихиям в итоге забега (tasks/T-0321): чистые функции
 * T-0125 и схема приёма. Правдоподобие — по структуре, без настраиваемых
 * порогов (Р7): серия не длиннее забега, убийства по стихиям не больше убитых.
 */

const ZERO: RunCounters = { bossKills: 0, eliteKills: 0, chestsOpened: 0, crystals: 0, noHitSec: 0, noKillSec: 0, killsByElement: {} };
const CONTEXT = { survivalSec: 600, enemiesKilled: 1000 };

describe("countersOf: новые поля", () => {
  it("без новых полей — нули и пустой словарь, старые поля читаются как были", () => {
    expect(countersOf({ bossKills: 1, eliteKills: 2, chestsOpened: 3, crystals: 4 })).toEqual({
      bossKills: 1,
      eliteKills: 2,
      chestsOpened: 3,
      crystals: 4,
      noHitSec: 0,
      noKillSec: 0,
      killsByElement: {},
    });
  });

  it("одни новые поля — это уже счётчики, а не их отсутствие", () => {
    expect(countersOf({ noHitSec: 600 })).toEqual({ ...ZERO, noHitSec: 600 });
    expect(countersOf({ killsByElement: { fire: 3 } })).toEqual({ ...ZERO, killsByElement: { fire: 3 } });
  });

  it("ни одного поля — null, как и до задачи", () => {
    expect(countersOf({})).toBeNull();
    expect(countersOf(undefined)).toBeNull();
  });
});

describe("правдоподобие серий и стихий", () => {
  it("серия без попаданий не длиннее забега: ровно равна — можно, больше — нет", () => {
    expect(countersPlausible({ ...ZERO, noHitSec: 600 }, CONTEXT)).toBe(true);
    expect(countersPlausible({ ...ZERO, noHitSec: 601 }, CONTEXT)).toBe(false);
  });

  it("серия без убийств тоже", () => {
    expect(countersPlausible({ ...ZERO, noKillSec: 600 }, CONTEXT)).toBe(true);
    expect(countersPlausible({ ...ZERO, noKillSec: 601 }, CONTEXT)).toBe(false);
  });

  it("сумма убийств по стихиям не больше убитых: ровно равна — можно, больше — нет", () => {
    expect(countersPlausible({ ...ZERO, killsByElement: { fire: 600, cold: 400 } }, CONTEXT)).toBe(true);
    expect(countersPlausible({ ...ZERO, killsByElement: { fire: 600, cold: 401 } }, CONTEXT)).toBe(false);
  });

  it("прежние проверки на месте: больше боссов и элит, чем убитых, по-прежнему неправдоподобно", () => {
    expect(countersPlausible({ ...ZERO, bossKills: 1001 }, CONTEXT)).toBe(false);
  });
});

describe("приём итога: схема", () => {
  const base = {
    runId: randomUUID(),
    difficultyId: "hard",
    outcome: "died",
    survivalSec: 600,
    level: 10,
    enemiesKilled: 1000,
    startingWeaponId: "spark",
    weapons: [{ id: "spark", level: 3 }],
    contentHash: "abc",
  };
  const stats = { damageTaken: 10, xpCollected: 100, waveReached: 3, topKills: [] };

  it("итог без новых полей разбирается: сборки и очередь до задачи их не шлют", () => {
    expect(runFinishSchema.safeParse({ ...base, stats }).success).toBe(true);
  });

  it("с новыми полями разбирается, словарь стихий — по четырём именам", () => {
    const parsed = runFinishSchema.safeParse({ ...base, stats: { ...stats, noHitSec: 300, noKillSec: 65, killsByElement: { fire: 3, poison: 1 } } });
    expect(parsed.success).toBe(true);
    expect(runFinishSchema.safeParse({ ...base, stats: { ...stats, killsByElement: { physical: 3 } } }).success).toBe(false);
    expect(runFinishSchema.safeParse({ ...base, stats: { ...stats, killsByElement: { fire: -1 } } }).success).toBe(false);
  });

  it("отрицательное, дробное и больше суток — отказ", () => {
    for (const bad of [-1, 1.5, 86_401]) {
      expect(runFinishSchema.safeParse({ ...base, stats: { ...stats, noHitSec: bad } }).success, `noHitSec ${String(bad)}`).toBe(false);
      expect(runFinishSchema.safeParse({ ...base, stats: { ...stats, noKillSec: bad } }).success, `noKillSec ${String(bad)}`).toBe(false);
    }
  });
});
