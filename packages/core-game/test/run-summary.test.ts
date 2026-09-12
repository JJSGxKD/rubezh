import type { EnemyDef, KeyValueStorage, RunResult, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { benchInput } from "../src/game/bench/autopilot";
import {
  deathScreenLines,
  formatDuration,
  offerLabel,
} from "../src/game/overlays/run-screens";
import { chooseUpgrade, isAwaitingChoice } from "../src/game/progression/levels";
import { loadBestSurvivalSec, submitRunResult } from "../src/game/run/records";
import { buildRunResult } from "../src/game/run/run-result";
import { stepWorld, IDLE_INPUT } from "../src/game/sim/step";
import { createConstantPopulationSpawner } from "../src/game/sim/spawner";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";
import { ALL_PATTERNS_WEIGHTS } from "./helpers/scripted-run";

// Статистика забега и его итог (docs/26-stage2-plan.md, WP3).

const MAX_TICKS = 60 * 240;

/** Прогон живого игрока до смерти: экран смерти показывает именно такой мир. */
function runUntilDeath(seed: number, population: number): World {
  const world = createWorld({
    seed,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
  });
  const spawner = createConstantPopulationSpawner(population, ALL_PATTERNS_WEIGHTS);

  for (let tick = 0; tick < MAX_TICKS && world.player.alive; tick++) {
    // Выбор делается до шага: пока он не сделан, мир стоит и цикл крутится
    // вхолостую до конца сценария.
    if (isAwaitingChoice(world)) chooseUpgrade(world, world.progression.offers[0].id);
    spawner.update(world, 1 / 60);
    stepWorld(world, benchInput(tick));
  }
  return world;
}

function resultOf(world: World, seed: number): RunResult {
  return buildRunResult(world, {
    runId: "test-run",
    seed,
    outcome: "died",
    startingWeaponId: "spark",
  });
}

describe("статистика забега", () => {
  // Популяция подобрана так, чтобы забег дожил до полного набора: с четырьмя
  // оружиями и четырьмя пассивками проверки разносят урон по слотам, а не
  // меряют одно стартовое оружие.
  const world = runUntilDeath(7, 20);

  it("доводит игрока до смерти с набранным арсеналом — иначе проверки ниже слабы", () => {
    expect(world.player.alive).toBe(false);
    expect(world.stats.elapsedSec).toBeGreaterThan(0);
    expect(world.stats.enemiesKilled).toBeGreaterThan(0);
    expect(world.loadout.weapons.length).toBeGreaterThan(1);
    expect(world.loadout.passives.length).toBeGreaterThan(0);
  });

  it("сходится: сумма урона по оружиям равна общему нанесённому урону", () => {
    // Единственная проверка, ради которой урон по оружиям вообще имеет смысл:
    // расхождение означает источник урона, который не записывается ни в одно
    // оружие, и баланс по этой таблице считать нельзя.
    let byWeapon = 0;
    let armed = 0;
    for (const damage of world.stats.damageByWeapon) {
      byWeapon += damage;
      if (damage > 0) armed++;
    }

    expect(armed).toBeGreaterThan(1);
    expect(byWeapon).toBeCloseTo(world.stats.damageDealt, 6);
  });

  it("сходится: сумма убийств по типам равна общему числу убитых", () => {
    let byType = 0;
    for (const kills of world.stats.killsByType) byType += kills;

    expect(byType).toBe(world.stats.enemiesKilled);
  });

  it("считает время выживания по тикам, а не по часам", () => {
    expect(world.stats.elapsedSec).toBeCloseTo(world.stats.tick / 60, 9);
  });

  it("копит собранный опыт вместе с прогрессией", () => {
    expect(world.stats.xpCollected).toBeCloseTo(world.progression.totalXp, 9);
  });

  it("считает расстояние по факту перемещения и не выходит за предел скорости", () => {
    const maxDistance =
      world.config.player.speedPxSec * world.playerStats.moveSpeedMul * world.stats.elapsedSec;

    expect(world.stats.distance).toBeGreaterThan(0);
    expect(world.stats.distance).toBeLessThanOrEqual(maxDistance);
  });

  it("запоминает пик врагов, а не текущее их число", () => {
    expect(world.stats.peakEnemies).toBeGreaterThanOrEqual(world.enemies.aliveCount);
    expect(world.stats.peakEnemies).toBeGreaterThan(0);
  });

  /**
   * Эталон забега: seed 7, популяция 20, выбор всегда первого варианта.
   *
   * Ломается при любой правке контента — и это правильно: в диффе PR видно,
   * как правка повлияла на длину забега и на то, чем игрок его прошёл
   * (docs/17-testing-strategy.md §3.2). Эталон обновляется в том же PR, что и
   * контент, — числами из упавшего теста, но только после того, как человек
   * посмотрел, стал ли забег таким, каким его хотели сделать.
   */
  it("совпадает с эталоном забега", () => {
    const result = resultOf(world, 7);

    expect({
      survivalSec: Number(result.survivalSec.toFixed(2)),
      level: result.level,
      xpCollected: result.xpCollected,
      enemiesKilled: result.enemiesKilled,
      killsByEnemy: result.killsByEnemy,
      damageDealt: Math.round(result.damageDealt),
      damageTaken: Math.round(result.damageTaken),
      weapons: result.weapons.map((weapon) => ({
        id: weapon.id,
        level: weapon.level,
        damage: Math.round(weapon.damage),
      })),
      passives: result.passives,
      deathCause: result.deathCause,
      distance: Math.round(result.distance),
      peakEnemies: result.peakEnemies,
    }).toEqual({
      survivalSec: 79.55,
      level: 13,
      xpCollected: 281,
      enemiesKilled: 174,
      killsByEnemy: {
        swarm_rat: 74,
        tank_ghoul: 10,
        shooter_wisp: 26,
        dasher_wolf: 13,
        circler_crow: 31,
        bomber_imp: 9,
        splitter_slime: 11,
      },
      damageDealt: 2080,
      damageTaken: 104,
      weapons: [
        { id: "spark", level: 2, damage: 1786 },
        { id: "wardstone", level: 2, damage: 114 },
        { id: "hearth", level: 1, damage: 123 },
        { id: "storm", level: 1, damage: 57 },
      ],
      passives: [
        { id: "volley", level: 1 },
        { id: "haste", level: 4 },
        { id: "swiftness", level: 1 },
        { id: "reach", level: 1 },
      ],
      deathCause: "shooter_wisp",
      distance: 12730,
      peakEnemies: 22,
    });
  });

  it("не зависит от прогона: тот же seed даёт ту же статистику", () => {
    const repeat = runUntilDeath(7, 20);
    expect(resultOf(repeat, 7)).toEqual(resultOf(world, 7));
  });
});

describe("итог забега", () => {
  const DUMMY: EnemyDef = { id: "dummy", hp: 500, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
  const BITER: EnemyDef = { id: "biter", hp: 500, speed: 0.001, damage: 40, xp: 1, pattern: "swarm" };
  const SPARK: WeaponDef = {
    id: "spark",
    behavior: "projectile_nearest",
    nameKey: "weapon.spark.name",
    descriptionKey: "weapon.spark.description",
    starting: true,
    levels: [{ damage: 10, cooldownSec: 0.2, projectiles: 1, projectileSpeed: 600, ttlSec: 2 }],
  };

  function worldWithEnemyAt(enemy: EnemyDef, offset: number): World {
    const world = createWorld({ seed: 1, enemies: [DUMMY, BITER], weapons: [SPARK] });
    const typeIndex = world.enemyTypes.findIndex((type) => type.id === enemy.id);
    spawnEnemy(world, typeIndex, world.player.x + offset, world.player.y);
    return world;
  }

  it("называет врага, который добил игрока", () => {
    const world = worldWithEnemyAt(BITER, 8);
    for (let tick = 0; tick < 60 * 20 && world.player.alive; tick++) {
      stepWorld(world, IDLE_INPUT);
    }

    const result = buildRunResult(world, {
      runId: "r1",
      seed: 42,
      outcome: "died",
      startingWeaponId: "spark",
    });
    expect(world.player.alive).toBe(false);
    expect(result.outcome).toBe("died");
    expect(result.deathCause).toBe("biter");
  });

  it("у сдачи нет причины смерти: сдавшийся забег — не убийство", () => {
    const world = worldWithEnemyAt(DUMMY, 40);
    for (let tick = 0; tick < 120; tick++) stepWorld(world, IDLE_INPUT);

    const result = buildRunResult(world, {
      runId: "r2",
      seed: 42,
      outcome: "abandoned",
      startingWeaponId: "spark",
    });
    expect(result.outcome).toBe("abandoned");
    expect(result.deathCause).toBeNull();
    expect(result.survivalSec).toBeGreaterThan(0);
  });

  it("отдаёт урон по id оружия, а не по номеру слота", () => {
    const world = worldWithEnemyAt(DUMMY, 40);
    for (let tick = 0; tick < 180; tick++) stepWorld(world, IDLE_INPUT);

    const result = buildRunResult(world, {
      runId: "r3",
      seed: 1,
      outcome: "abandoned",
      startingWeaponId: "spark",
    });
    expect(result.weapons).toHaveLength(1);
    expect(result.weapons[0].id).toBe("spark");
    expect(result.weapons[0].level).toBe(1);
    expect(result.weapons[0].damage).toBeGreaterThan(0);
  });

  it("не тащит в выгрузку врагов, которых не убивали", () => {
    const world = worldWithEnemyAt(DUMMY, 40);
    for (let tick = 0; tick < 60 * 30 && world.enemies.aliveCount > 0; tick++) {
      stepWorld(world, IDLE_INPUT);
    }

    const result = buildRunResult(world, {
      runId: "r4",
      seed: 1,
      outcome: "abandoned",
      startingWeaponId: "spark",
    });
    expect(result.killsByEnemy).toEqual({ dummy: 1 });
  });
});

describe("локальный рекорд", () => {
  function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & {
    values: Record<string, string>;
  } {
    const values = { ...initial };
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

  function resultWith(survivalSec: number): RunResult {
    return {
      runId: "r",
      seed: 1,
      outcome: "died",
      startingWeaponId: "spark",
      survivalSec,
      level: 1,
      xpCollected: 0,
      enemiesKilled: 0,
      killsByEnemy: {},
      damageDealt: 0,
      damageTaken: 0,
      weapons: [],
      passives: [],
      deathCause: null,
      distance: 0,
      peakEnemies: 0,
    };
  }

  it("считает рекордом только то, что лучше прошлого", () => {
    const storage = memoryStorage();

    expect(submitRunResult(storage, resultWith(30)).isNewRecord).toBe(true);
    expect(submitRunResult(storage, resultWith(20))).toEqual({
      bestSurvivalSec: 30,
      isNewRecord: false,
    });
    expect(submitRunResult(storage, resultWith(45)).bestSurvivalSec).toBe(45);
    expect(loadBestSurvivalSec(storage)).toBe(45);
  });

  it("сбрасывает битое значение вместо того, чтобы показать его игроку", () => {
    const storage = memoryStorage({ "bh.meta.v1.bestSurvivalSec": "полтора часа" });

    expect(loadBestSurvivalSec(storage)).toBe(0);
    expect(storage.values["bh.meta.v1.bestSurvivalSec"]).toBeUndefined();
  });

  it("не верит невозможному результату: забег длиннее суток — испорченное значение", () => {
    const storage = memoryStorage({ "bh.meta.v1.bestSurvivalSec": "999999999" });

    expect(loadBestSurvivalSec(storage)).toBe(0);
  });

  it("живёт без хранилища: рекорд не переживёт запуск, но забег не упадёт", () => {
    expect(loadBestSurvivalSec(undefined)).toBe(0);
    expect(submitRunResult(undefined, resultWith(12))).toEqual({
      bestSurvivalSec: 12,
      isNewRecord: true,
    });
  });
});

describe("тексты экранов забега", () => {
  const result: RunResult = {
    runId: "abc-123",
    seed: 777,
    outcome: "died",
    startingWeaponId: "spark",
    survivalSec: 185.4,
    level: 7,
    xpCollected: 214,
    enemiesKilled: 143,
    killsByEnemy: { grunt: 100, wolf: 43 },
    damageDealt: 1880,
    damageTaken: 118,
    weapons: [
      { id: "spark", level: 4, damage: 640 },
      { id: "wardstone", level: 2, damage: 1240 },
    ],
    passives: [{ id: "might", level: 2 }],
    deathCause: "wolf",
    distance: 2140,
    peakEnemies: 64,
  };
  const record = { bestSurvivalSec: 185.4, isNewRecord: true };

  it("показывает время как минуты и секунды", () => {
    expect(formatDuration(185.4)).toBe("3:05");
    expect(formatDuration(0)).toBe("0:00");
    // Отрицательное и NaN приходят только из битого хранилища, но показывать
    // «NaN:aN» игроку нельзя.
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
  });

  it("ставит время выживания первым и отмечает новый рекорд", () => {
    const lines = deathScreenLines({ result, record, diagnostics: false, note: "" });

    expect(lines[1]).toBe("Время выживания: 3:05");
    expect(lines).toContain("НОВЫЙ РЕКОРД");
  });

  it("сортирует оружие по урону: сверху то, что тянуло забег", () => {
    const lines = deathScreenLines({ result, record, diagnostics: false, note: "" });
    const weapons = lines.filter((line) => line.startsWith("  "));

    expect(weapons[0]).toContain("wardstone");
    expect(weapons[1]).toContain("spark");
  });

  it("показывает seed и runId только в режиме диагностики", () => {
    const plain = deathScreenLines({ result, record, diagnostics: false, note: "" });
    const diag = deathScreenLines({ result, record, diagnostics: true, note: "" });

    expect(plain.join("\n")).not.toContain("abc-123");
    expect(diag.join("\n")).toContain("seed 777 | runId abc-123");
  });

  it("подписывает лечение словом, а не пустым id", () => {
    expect(
      offerLabel({
        id: "heal",
        kind: "heal",
        refId: "",
        level: 0,
        nameKey: "upgrade.heal.name",
        descriptionKey: "upgrade.heal.description",
      }),
    ).toBe("Лечение");
  });
});
