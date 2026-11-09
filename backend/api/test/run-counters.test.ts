import { describe, expect, it } from "vitest";
import { ENEMIES } from "../../../packages/core-game/src/content/enemies";
import { ENDLESS_CURVE, TIMELINE } from "../../../packages/core-game/src/content/waves";
import { MAX_GEMS_PER_KILL } from "../../../packages/core-game/src/game/sim/gems";
import { planSegment } from "../../../packages/core-game/src/game/sim/timeline";
import { createWorld } from "../../../packages/core-game/src/game/sim/world";
import { runFinishSchema } from "../src/modules/runs/dto/runs.dto.js";
import { detailsOf, storedDetailsSchema } from "../src/modules/runs/run-details.js";
import { countersOf,countersPlausible, GEMS_PER_KILL_CEILING, rankBudget, type RunCounters } from "../src/modules/runs/run-counters.js";

/**
 * Счётчики итога забега (tasks/T-0125): чистые функции. Таблица бюджета рангов
 * живёт на сервере отдельно от `core-game` (сервер движок не импортирует), и
 * этот тест — единственное, что не даёт ей разойтись с таймлайном.
 */

const ZERO: RunCounters = { bossKills: 0, eliteKills: 0, chestsOpened: 0, rareChests: 0, crystals: 0, noHitSec: 0, noKillSec: 0, killsByElement: {} };

describe("countersOf", () => {
  it("без stats — null", () => {
    expect(countersOf(undefined)).toBeNull();
  });

  it("stats прислан, а новых полей нет (старая сборка) — null", () => {
    expect(countersOf({})).toBeNull();
  });

  it("часть полей — остальные нули", () => {
    expect(countersOf({ bossKills: 2, crystals: 40 })).toEqual({ ...ZERO, bossKills: 2, crystals: 40 });
  });

  it("все четыре поля передаются как есть", () => {
    expect(countersOf({ bossKills: 1, eliteKills: 2, chestsOpened: 3, crystals: 4 })).toEqual({
      ...ZERO,
      bossKills: 1,
      eliteKills: 2,
      chestsOpened: 3,
      rareChests: 0,
      crystals: 4,
    });
  });

  it("явные нули — это счётчики, а не их отсутствие", () => {
    expect(countersOf({ bossKills: 0 })).toEqual(ZERO);
  });
});

describe("rankBudget", () => {
  it("в нуле — ни элит, ни боссов", () => {
    expect(rankBudget(0)).toEqual({ elite: 0, boss: 0 });
  });

  it("не убывает по времени на сетке 0…7200 с", () => {
    let previous = rankBudget(0);
    for (let sec = 1; sec <= 7200; sec++) {
      const now = rankBudget(sec);
      expect(now.elite, `${sec} с`).toBeGreaterThanOrEqual(previous.elite);
      expect(now.boss, `${sec} с`).toBeGreaterThanOrEqual(previous.boss);
      previous = now;
    }
  });

  it("на суточном забеге конечен", () => {
    const budget = rankBudget(86_400);
    expect(Number.isFinite(budget.elite)).toBe(true);
    expect(Number.isFinite(budget.boss)).toBe(true);
    expect(budget.elite).toBeGreaterThan(0);
    expect(budget.boss).toBeGreaterThan(0);
  });

  it("первая элита приходит ровно в назначенную секунду, не раньше", () => {
    expect(rankBudget(89.999).elite).toBe(0);
    expect(rankBudget(90).elite).toBe(1);
  });

  it("совпадает с таймлайном контента: события элит и боссов, ранг по ENEMIES", () => {
    const world = createWorld({ seed: 1, enemies: ENEMIES });
    let elite = 0;
    let boss = 0;
    // Мимо кратного всем «каждые N отрезков» (4–9) — несколько кругов.
    const segments = TIMELINE.length + 450;

    for (let index = 0; index < segments; index++) {
      const plan = planSegment(world, TIMELINE, ENDLESS_CURVE, index);
      // До начала отрезка его событий в бюджете нет, с начала — есть.
      if (plan.fromSec > 0) {
        expect(rankBudget(plan.fromSec - 0.001), `перед отрезком ${index}`).toEqual({ elite, boss });
      }
      for (const event of plan.events) {
        const rank = world.enemyTypes[event.typeIndex].rank;
        if (rank === "elite") elite += event.count;
        if (rank === "boss") boss += event.count;
        // Элита внутри кольца стражей (`ring.inner`) тоже убивается.
        for (const entry of event.ring?.inner ?? []) {
          const innerRank = world.enemyTypes.find((type) => type.id === entry.enemy)?.rank;
          if (innerRank === "elite") elite += entry.count;
          if (innerRank === "boss") boss += entry.count;
        }
      }
      expect(rankBudget(plan.fromSec), `в начале отрезка ${index}`).toEqual({ elite, boss });
    }
    expect(elite).toBeGreaterThan(0);
    expect(boss).toBeGreaterThan(0);
  });

  it("врагов-элит и боссов нет среди потомков делящихся: иначе бюджет считался бы иначе", () => {
    const rankOf = new Map(ENEMIES.map((enemy) => [enemy.id, enemy.rank ?? "normal"]));
    for (const enemy of ENEMIES) {
      if (enemy.pattern !== "splitter") continue;
      for (const child of enemy.params?.children ?? []) {
        expect(rankOf.get(child.enemy), `${enemy.id} → ${child.enemy}`).toBe("normal");
      }
    }
  });

  it("элиты и боссы приходят только событиями: ни в потоках, ни в выбросах отрезков, ни в пуле кривой", () => {
    const rankOf = new Map(ENEMIES.map((enemy) => [enemy.id, enemy.rank ?? "normal"]));
    for (const segment of TIMELINE) {
      for (const spawn of segment.spawns ?? []) expect(rankOf.get(spawn.enemy), spawn.enemy).toBe("normal");
    }
    for (const id of ENDLESS_CURVE.pool) expect(rankOf.get(id), id).toBe("normal");
  });
});

describe("GEMS_PER_KILL_CEILING", () => {
  it("равен потолку горсти в движке", () => {
    expect(GEMS_PER_KILL_CEILING).toBe(MAX_GEMS_PER_KILL);
  });
});

describe("countersPlausible", () => {
  const run = { survivalSec: 600, enemiesKilled: 2000 };

  it("нули — правдоподобно", () => {
    expect(countersPlausible(ZERO, run)).toBe(true);
    expect(countersPlausible(ZERO, { survivalSec: 0, enemiesKilled: 0 })).toBe(true);
  });

  it("ровно на бюджете рангов — правдоподобно, на единицу выше — нет", () => {
    const budget = rankBudget(run.survivalSec);
    expect(budget.elite).toBeGreaterThan(0);
    expect(budget.boss).toBeGreaterThan(0);

    expect(countersPlausible({ ...ZERO, eliteKills: budget.elite }, run)).toBe(true);
    expect(countersPlausible({ ...ZERO, eliteKills: budget.elite + 1 }, run)).toBe(false);
    expect(countersPlausible({ ...ZERO, bossKills: budget.boss }, run)).toBe(true);
    expect(countersPlausible({ ...ZERO, bossKills: budget.boss + 1 }, run)).toBe(false);
  });

  it("убитых боссов и элит больше, чем убитых вообще, — нет", () => {
    expect(countersPlausible({ ...ZERO, bossKills: 1, eliteKills: 1 }, { survivalSec: 600, enemiesKilled: 2 })).toBe(true);
    expect(countersPlausible({ ...ZERO, bossKills: 1, eliteKills: 1 }, { survivalSec: 600, enemiesKilled: 1 })).toBe(false);
  });

  it("сундуков открыто больше, чем убито элит и боссов, — нет", () => {
    const killed: RunCounters = { ...ZERO, bossKills: 1, eliteKills: 2, chestsOpened: 3 };
    expect(countersPlausible(killed, run)).toBe(true);
    expect(countersPlausible({ ...killed, chestsOpened: 4 }, run)).toBe(false);
    expect(countersPlausible({ ...ZERO, chestsOpened: 1 }, run)).toBe(false);
  });

  it("кристаллов больше, чем убитых на потолок горсти, — нет; ровно на границе — да", () => {
    const limit = run.enemiesKilled * GEMS_PER_KILL_CEILING;
    expect(countersPlausible({ ...ZERO, crystals: limit }, run)).toBe(true);
    expect(countersPlausible({ ...ZERO, crystals: limit + 1 }, run)).toBe(false);
  });
});

describe("редкие сундуки (T-0175)", () => {
  const run = { survivalSec: 600, enemiesKilled: 2000 };
  const opened: RunCounters = { ...ZERO, bossKills: 1, eliteKills: 2, chestsOpened: 2 };
  const body = {
    runId: "3f6b1a52-8c1e-4d6a-9b6e-1d2c3b4a5f61",
    difficultyId: "hard",
    outcome: "died",
    survivalSec: 120,
    level: 6,
    enemiesKilled: 300,
    startingWeaponId: "knife",
    weapons: [{ id: "knife", level: 2 }],
    contentHash: "abc",
    deathCause: "swarm_rat",
    cheats: false,
    countInRating: false,
  };
  const baseStats = { damageTaken: 1, xpCollected: 1, waveReached: 1, topKills: [] };

  it("countersOf читает rareChests; нет поля — 0", () => {
    expect(countersOf({ bossKills: 1, chestsOpened: 2, rareChests: 1 })).toEqual({ ...ZERO, bossKills: 1, chestsOpened: 2, rareChests: 1 });
    expect(countersOf({ bossKills: 1, chestsOpened: 2 })?.rareChests).toBe(0);
  });

  it("одно только rareChests — уже счётчики, а не их отсутствие", () => {
    expect(countersOf({ rareChests: 1 })).toEqual({ ...ZERO, rareChests: 1 });
  });

  it("редких не больше, чем открытых сундуков: на границе — да, на единицу выше — нет", () => {
    expect(countersPlausible({ ...opened, rareChests: 0 }, run)).toBe(true);
    expect(countersPlausible({ ...opened, rareChests: 2 }, run)).toBe(true);
    expect(countersPlausible({ ...opened, rareChests: 3 }, run)).toBe(false);
  });

  it("редкие без единого открытого сундука — нет", () => {
    expect(countersPlausible({ ...ZERO, rareChests: 1 }, run)).toBe(false);
  });

  it("схема приёма: целое неотрицательное, поле необязательное", () => {
    expect(runFinishSchema.safeParse({ ...body, stats: baseStats }).success).toBe(true);
    expect(runFinishSchema.parse({ ...body, stats: { ...baseStats, chestsOpened: 3, rareChests: 2 } }).stats).toMatchObject({ rareChests: 2 });
    expect(runFinishSchema.safeParse({ ...body, stats: { ...baseStats, rareChests: -1 } }).success).toBe(false);
    expect(runFinishSchema.safeParse({ ...body, stats: { ...baseStats, rareChests: 1.5 } }).success).toBe(false);
    expect(runFinishSchema.safeParse({ ...body, stats: { ...baseStats, rareChests: 1_000_001 } }).success).toBe(false);
  });

  it("detailsOf кладёт rareChests; не пришло — null; строка прошлой сборки без ключа читается как null", () => {
    expect(detailsOf({ passives: [], stats: { ...baseStats, chestsOpened: 3, rareChests: 2 } })).toMatchObject({ rareChests: 2 });
    expect(detailsOf({ passives: [], stats: baseStats })).toMatchObject({ rareChests: null });

    const old = { passives: [], damageTaken: 1, xpCollected: 2, waveReached: 3, topKills: [], bossKills: 1, chestsOpened: 2 };
    expect(storedDetailsSchema.parse(old)).toMatchObject({ chestsOpened: 2, rareChests: null });
  });
});
