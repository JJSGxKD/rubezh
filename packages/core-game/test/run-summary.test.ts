import type { DifficultyId, EnemyDef, KeyValueStorage, RunResult, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { DROPS } from "../src/content/drops";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { benchInput } from "../src/game/bench/autopilot";
import { chooseUpgrade, isAwaitingChoice } from "../src/game/progression/levels";
import { loadBestSurvivalSec, mergeBestSurvivalSec, submitRunResult } from "../src/game/run/records";
import { buildRunResult } from "../src/game/run/run-result";
import { stepWorld, IDLE_INPUT } from "../src/game/sim/step";
import { createConstantPopulationSpawner } from "../src/game/sim/spawner";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";
import { ALL_PATTERNS_WEIGHTS } from "./helpers/scripted-run";

// Статистика забега и его итог (docs/26-stage2-plan.md, WP3).

/**
 * Потолок сценария. Поднят с четырёх минут до восьми вместе с отдалением
 * камеры: кольцо спавна считается от видимой области, стало шире, и те же
 * двадцать врагов приходят разреженнее — прежних четырёх минут игроку стало
 * хватать, чтобы дожить до конца сценария, а эталон про смерть.
 */
const MAX_TICKS = 60 * 480;

/**
 * Популяция эталонного сценария. Поднята с двадцати вместе с отдалением
 * камеры: кольцо спавна считается от видимой области, стало шире, и прежние
 * двадцать врагов приходили так разреженно, что игрок доживал до конца
 * сценария. Эталон — про смерть, а не про то, как долго он не наступает.
 */
const GOLDEN_POPULATION = 28;

/**
 * Seed эталона. Подобран так, чтобы забег дожил до полного набора: с тремя
 * оружиями проверки ниже разносят урон по слотам, а не меряют одно стартовое.
 * Меняется, когда правка выпадения сдвигает генератор и выбранный seed
 * перестаёт доживать до набора: так было с горстью кристаллов, броском на
 * аптечку и магнитом с динамитом. Распределение времени по seed при этом остаётся прежним, поэтому
 * смена seed — не подгонка результата, а возврат эталону его смысла.
 */
const GOLDEN_SEED = 5;

/** Прогон живого игрока до смерти: экран смерти показывает именно такой мир. */
function runUntilDeath(seed: number, population: number): World {
  const world = createWorld({
    seed,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
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
    contentHash: "test-hash",
  });
}

describe("статистика забега", () => {
  // Популяция подобрана так, чтобы забег дожил до полного набора: с тремя
  // оружиями и пассивками разных категорий проверки разносят урон по слотам, а не
  // меряют одно стартовое оружие.
  const world = runUntilDeath(GOLDEN_SEED, GOLDEN_POPULATION);

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
   * Эталон забега: seed GOLDEN_SEED, популяция GOLDEN_POPULATION, выбор всегда первого
   * варианта.
   *
   * Ломается при любой правке контента — и это правильно: в диффе PR видно,
   * как правка повлияла на длину забега и на то, чем игрок его прошёл
   * (docs/17-testing-strategy.md §3.2). Эталон обновляется в том же PR, что и
   * контент, — числами из упавшего теста, но только после того, как человек
   * посмотрел, стал ли забег таким, каким его хотели сделать.
   */
  it("совпадает с эталоном забега", () => {
    const result = resultOf(world, GOLDEN_SEED);

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
      survivalSec: 29.57,
      level: 7,
      xpCollected: 82,
      enemiesKilled: 53,
      killsByEnemy: {
        swarm_rat: 34,
        tank_ghoul: 2,
        shooter_wisp: 5,
        dasher_wolf: 2,
        circler_crow: 3,
        bomber_imp: 4,
        splitter_slime: 3,
      },
      damageDealt: 732,
      damageTaken: 104,
      weapons: [
        { id: "spark", level: 1, damage: 535 },
        { id: "knife", level: 1, damage: 147 },
        { id: "wardstone", level: 1, damage: 50 },
      ],
      passives: [
        { id: "reach", level: 1 },
        { id: "lodestone", level: 1 },
        { id: "haste", level: 1 },
        { id: "mending", level: 1 },
      ],
      deathCause: "shooter_wisp",
      distance: 4560,
      peakEnemies: 30,
    });
  });

  it("не зависит от прогона: тот же seed даёт ту же статистику", () => {
    const repeat = runUntilDeath(GOLDEN_SEED, GOLDEN_POPULATION);
    expect(resultOf(repeat, GOLDEN_SEED)).toEqual(resultOf(world, GOLDEN_SEED));
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
      contentHash: "test-hash",
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
      contentHash: "test-hash",
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
      contentHash: "test-hash",
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
      contentHash: "test-hash",
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

  function resultWith(survivalSec: number, difficultyId: DifficultyId = "normal"): RunResult {
    return {
      runId: "r",
      seed: 1,
      outcome: "died",
      startingWeaponId: "spark",
      contentHash: "test-hash",
      mapId: "fallback",
      difficultyId,
      waveReached: 0,
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
      cheats: false,
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
    expect(loadBestSurvivalSec(storage, "normal")).toBe(45);
  });

  it("ведёт рекорд по каждой сложности отдельно", () => {
    const storage = memoryStorage();

    submitRunResult(storage, resultWith(600, "easy"));
    // Десять минут на «Лёгкой» не мешают первому рекорду на «Сложной».
    expect(submitRunResult(storage, resultWith(90, "hard")).isNewRecord).toBe(true);
    expect(loadBestSurvivalSec(storage, "easy")).toBe(600);
    expect(loadBestSurvivalSec(storage, "hard")).toBe(90);
    expect(loadBestSurvivalSec(storage, "normal")).toBe(0);
  });

  it("переносит рекорд, поставленный до сложностей, на «Лёгкую» — тот же баланс", () => {
    const storage = memoryStorage({ "bh.meta.v1.bestSurvivalSec": "74.2" });

    expect(loadBestSurvivalSec(storage, "normal")).toBe(0);
    expect(loadBestSurvivalSec(storage, "easy")).toBe(74.2);
    expect(storage.values["bh.meta.v1.bestSurvivalSec"]).toBeUndefined();
    expect(storage.values["bh.meta.v1.bestSurvivalSec.easy"]).toBe("74.2");
  });

  it("сбрасывает битое значение вместо того, чтобы показать его игроку", () => {
    const storage = memoryStorage({ "bh.meta.v1.bestSurvivalSec.normal": "полтора часа" });

    expect(loadBestSurvivalSec(storage, "normal")).toBe(0);
    expect(storage.values["bh.meta.v1.bestSurvivalSec.normal"]).toBeUndefined();
  });

  it("не верит невозможному результату: забег длиннее суток — испорченное значение", () => {
    const storage = memoryStorage({ "bh.meta.v1.bestSurvivalSec.normal": "999999999" });

    expect(loadBestSurvivalSec(storage, "normal")).toBe(0);
  });

  it("живёт без хранилища: рекорд не переживёт запуск, но забег не упадёт", () => {
    expect(loadBestSurvivalSec(undefined, "normal")).toBe(0);
    expect(submitRunResult(undefined, resultWith(12))).toEqual({
      bestSurvivalSec: 12,
      isNewRecord: true,
    });
  });

  it("принимает рекорд с другого устройства, только если он лучше местного", () => {
    const storage = memoryStorage({ "bh.meta.v1.bestSurvivalSec.normal": "120" });

    expect(mergeBestSurvivalSec(storage, "normal", 90)).toBe(120);
    expect(mergeBestSurvivalSec(storage, "normal", 300)).toBe(300);
    expect(mergeBestSurvivalSec(storage, "normal", Number.NaN)).toBe(300);
    // После слияния «Новый рекорд» загорается только на результате лучше серверного.
    expect(submitRunResult(storage, { ...resultWith(200), difficultyId: "normal" }).isNewRecord).toBe(false);
  });
});
