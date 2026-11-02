import type { EndlessCurveDef, EnemyStageDef, TimelineSegmentDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { PRESSURE } from "../src/content/pressure";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { checksumWorld } from "../src/game/sim/checksum";
import { createTimelineDirector } from "../src/game/sim/director";
import { leversOf, pressureLevelOf } from "../src/game/sim/pressure";
import { pickStage } from "../src/game/sim/stages";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { planSegment } from "../src/game/sim/timeline";
import { TICK_SEC, type World } from "../src/game/sim/world";
import { FULL_GEAR, makeContentWorld, makePressureWorld, MEDIUM_GEAR, TEST_PRESSURE } from "./helpers/pressure-fixture";

// Подстройка давления под силу игрока (tasks/T-0195, решения 5–9, Р131, Р183).

const LONG_RUN = { timeout: 60_000 };

/** Один отрезок со своим потолком живых: под него считаются все ожидания. */
function singleSegment(maxAlive: number): TimelineSegmentDef[] {
  return [{ fromSec: 0, maxAlive, spawns: [{ enemy: "swarm_rat", perSec: 2 }] }];
}

/** Мир «сильнее опорного»: 1,25 за слоты и 1 за урон дают 2,25 очка, а это ровно потолок давления 1,5. */
function strongWorld(patch: Parameters<typeof makePressureWorld>[0] = {}): World {
  return makePressureWorld({ modifiers: { damage: 1 }, ...patch });
}

/** Мир новичка: один слот оружия и ничего больше — давление упирается в нижний предел. */
function noviceWorld(patch: Parameters<typeof makePressureWorld>[0] = {}): World {
  return makePressureWorld({ limits: { weapons: 1, passives: { attack: 0, defense: 0, mobility: 0 } }, ...patch });
}

describe("уровень давления", () => {
  it("у опорного игрока давление ровно единица", () => {
    expect(pressureLevelOf(TEST_PRESSURE, 1.25)).toBe(1);
  });

  it("выше опорного растёт линейно по spanUp и упирается в верхний предел", () => {
    expect(pressureLevelOf(TEST_PRESSURE, 1.75)).toBe(1.25);
    expect(pressureLevelOf(TEST_PRESSURE, 2.25)).toBe(1.5);
    expect(pressureLevelOf(TEST_PRESSURE, 100)).toBe(1.5);
  });

  it("ниже опорного падает линейно по spanDown и упирается в нижний предел", () => {
    expect(pressureLevelOf(TEST_PRESSURE, 1.125)).toBe(0.875);
    expect(pressureLevelOf(TEST_PRESSURE, 1)).toBe(0.75);
    expect(pressureLevelOf(TEST_PRESSURE, 0.75)).toBe(0.75);
    expect(pressureLevelOf(TEST_PRESSURE, -3)).toBe(0.75);
  });
});

describe("рычаги", () => {
  it("вверх работает набор up: толпа и события, здоровье и урон едва-едва, ступени на месте (Р183)", () => {
    const levers = leversOf(TEST_PRESSURE, 1.5);
    expect(levers.hpScale).toBe(1.0625);
    expect(levers.damageScale).toBe(1.125);
    expect(levers.spawnScale).toBe(1.5);
    expect(levers.aliveScale).toBe(1.25);
    expect(levers.stageShiftSec).toBe(0);
    expect(levers.eliteLead).toBe(1);
    expect(levers.bossLead).toBe(1);
  });

  it("вниз работает набор down: все рычаги, ступени открываются позже", () => {
    const levers = leversOf(TEST_PRESSURE, 0.75);
    expect(levers.hpScale).toBe(0.75);
    expect(levers.damageScale).toBe(0.875);
    expect(levers.spawnScale).toBe(0.875);
    expect(levers.aliveScale).toBe(0.875);
    expect(levers.stageShiftSec).toBe(-25);
    expect(levers.eliteLead).toBe(-1);
    // Боссы только вперёд: нижний предел босса — ноль.
    expect(levers.bossLead).toBe(0);
  });

  it("на опорном уровне — единицы и нули, без минус нуля", () => {
    const levers = leversOf(TEST_PRESSURE, 1);
    expect(levers).toEqual({ hpScale: 1, damageScale: 1, spawnScale: 1, aliveScale: 1, stageShiftSec: 0, eliteLead: 0, bossLead: 0 });
    expect(Object.is(levers.stageShiftSec, 0)).toBe(true);
    expect(Object.is(levers.eliteLead, 0)).toBe(true);
    expect(Object.is(levers.bossLead, 0)).toBe(true);
  });

  it("чуть ниже опорного округление не оставляет минус нуля в сдвигах", () => {
    const levers = leversOf(TEST_PRESSURE, 0.999);
    expect(Object.is(levers.stageShiftSec, 0)).toBe(true);
    expect(Object.is(levers.eliteLead, 0)).toBe(true);
    expect(Object.is(levers.bossLead, 0)).toBe(true);
  });

  it("при любом уровне не ниже опорного ступени не сдвигаются", () => {
    for (const level of [1, 1.1, 1.25, 1.5]) expect(leversOf(TEST_PRESSURE, level).stageShiftSec).toBe(0);
  });
});

describe("директор: множители отрезка", () => {
  it("сильному игроку: больше врагов, здоровье и урон едва-едва выше", () => {
    const world = strongWorld();
    expect(world.difficulty.pressureLevel).toBe(1.5);
    createTimelineDirector(singleSegment(200), ENDLESS_CURVE).update(world, TICK_SEC);

    expect(world.difficulty.hpMul).toBe(1 * 1 * 1.0625);
    expect(world.difficulty.damageMul).toBe(1 * 1 * 1.125);
    expect(world.difficulty.spawnMul).toBe(1.5);
    expect(world.difficulty.maxAlive).toBe(Math.round(200 * 1 * 1.25));
  });

  it("новичку: мягче по всем рычагам", () => {
    const world = noviceWorld();
    expect(world.difficulty.pressureLevel).toBe(0.75);
    createTimelineDirector(singleSegment(200), ENDLESS_CURVE).update(world, TICK_SEC);

    expect(world.difficulty.hpMul).toBe(0.75);
    expect(world.difficulty.damageMul).toBe(0.875);
    expect(world.difficulty.spawnMul).toBe(0.875);
    expect(world.difficulty.maxAlive).toBe(Math.round(200 * 0.875));
  });

  it("множители ложатся поверх уровня сложности, а не вместо него", () => {
    const hard = { id: "hard", nameKey: "", descriptionKey: "", enemyHpMul: 1.5, enemyDamageMul: 1.25, spawnRateMul: 1.5, maxAliveMul: 1.5 } as const;
    const world = strongWorld({ difficulty: hard });
    createTimelineDirector(singleSegment(200), ENDLESS_CURVE).update(world, TICK_SEC);

    expect(world.difficulty.hpMul).toBe(1 * 1.5 * 1.0625);
    expect(world.difficulty.damageMul).toBe(1 * 1.25 * 1.125);
    expect(world.difficulty.maxAlive).toBe(Math.round(200 * 1.5 * 1.25));
  });

  it("темп спавна умножается на spawnMul: сильному приходит больше врагов за те же секунды", LONG_RUN, () => {
    const spawned = (world: World): number => {
      const director = createTimelineDirector(singleSegment(200), ENDLESS_CURVE);
      for (let tick = 0; tick < 20 * 60; tick++) {
        director.update(world, TICK_SEC);
        stepWorld(world, IDLE_INPUT);
      }
      return world.stats.enemiesSpawned;
    };
    const strong = spawned(strongWorld());
    const novice = spawned(noviceWorld());
    expect(strong).toBeGreaterThan(novice);
    // Два врага в секунду на двадцать секунд: 1,5 против 0,875 от базового темпа.
    expect(strong).toBeGreaterThanOrEqual(50);
    expect(novice).toBeLessThanOrEqual(40);
  });

  it("пересчитывает силу на входе в каждый отрезок: отставший набор снижает давление", () => {
    const timeline: TimelineSegmentDef[] = [
      { fromSec: 0, maxAlive: 200, spawns: [{ enemy: "swarm_rat", perSec: 1 }] },
      { fromSec: 200, maxAlive: 200, spawns: [{ enemy: "swarm_rat", perSec: 1 }] },
    ];
    const world = makePressureWorld();
    const director = createTimelineDirector(timeline, ENDLESS_CURVE);
    director.update(world, TICK_SEC);
    expect(world.difficulty.pressureLevel).toBe(1);
    expect(world.difficulty.spawnMul).toBe(1);

    // На 200-й секунде ожидается полный набор, а собрано оружие первого уровня: потолок помощи −0,5.
    world.stats.elapsedSec = 200;
    director.update(world, TICK_SEC);
    expect(world.difficulty.power).toBe(0.75);
    expect(world.difficulty.pressureLevel).toBe(0.75);
    expect(world.difficulty.spawnMul).toBe(0.875);
    // Старт не переписывается: аналитика сравнивает силу на старте с силой в конце.
    expect(world.difficulty.startPower).toBe(1.25);
    expect(world.difficulty.startPressure).toBe(1);
  });

  it("между отрезками ничего не пересчитывается: враг, вышедший раньше, не меняется", () => {
    const world = strongWorld();
    const director = createTimelineDirector(singleSegment(200), ENDLESS_CURVE);
    director.update(world, TICK_SEC);
    const hp = world.difficulty.hpMul;
    world.loadoutModifiers = { ...world.loadoutModifiers, damage: 3 };
    world.runLoadout.modifiers = { ...world.runLoadout.modifiers, damage: 3 };
    for (let tick = 0; tick < 600; tick++) director.update(world, TICK_SEC);
    expect(world.difficulty.hpMul).toBe(hp);
  });
});

describe("слабое устройство", () => {
  /**
   * Опорный игрок: давление ровно единица, поэтому желаемый потолок — ровно тот, что в отрезке. Помощь
   * отстающему отключена (`buildPoints 0`): на 60-й и 120-й секундах набор из одного оружия иначе её получил бы.
   */
  const REFERENCE_RULES = { ...TEST_PRESSURE, power: { ...TEST_PRESSURE.power, buildPoints: 0 } };
  function deviceWorld(deviceClass: "light" | "standard", elapsedSec: number, patch: Parameters<typeof makePressureWorld>[0] = {}): World {
    return makePressureWorld({ deviceClass, elapsedSec, pressure: REFERENCE_RULES, ...patch });
  }

  it("потолок живых ниже, а до compensateFromSec добавки нет", () => {
    const world = deviceWorld("light", 0);
    createTimelineDirector(singleSegment(200), ENDLESS_CURVE).update(world, TICK_SEC);
    expect(world.difficulty.maxAlive).toBe(100);
    expect(world.difficulty.hpMul).toBe(1);
    expect(world.difficulty.damageMul).toBe(1);
  });

  it("с compensateFromSec недостающее добирают здоровье и урон", () => {
    const world = deviceWorld("light", 60);
    createTimelineDirector(singleSegment(200), ENDLESS_CURVE).update(world, TICK_SEC);
    // shortfall = min(2, 200 / 100) = 2: здоровье и урон × (1 + 0,5 × 1).
    expect(world.difficulty.maxAlive).toBe(100);
    expect(world.difficulty.hpMul).toBe(1 * 1 * 1 * (1 + 0.5 * (2 - 1)));
    expect(world.difficulty.damageMul).toBe(1 * 1 * 1 * (1 + 0.5 * (2 - 1)));
  });

  it("добавка пропорциональна урезанному: желаемых 150 при потолке 100 — × 1,25", () => {
    const world = deviceWorld("light", 120);
    createTimelineDirector(singleSegment(150), ENDLESS_CURVE).update(world, TICK_SEC);
    expect(world.difficulty.maxAlive).toBe(100);
    expect(world.difficulty.hpMul).toBe(1.25);
    expect(world.difficulty.damageMul).toBe(1.25);
  });

  it("добавка упирается в maxShortfall", () => {
    const world = deviceWorld("light", 120);
    createTimelineDirector(singleSegment(900), ENDLESS_CURVE).update(world, TICK_SEC);
    // 900 / 100 = 9, но не больше 2.
    expect(world.difficulty.hpMul).toBe(1.5);
    expect(world.difficulty.damageMul).toBe(1.5);
  });

  it("если потолок устройства ничего не урезал, добавки нет", () => {
    const world = deviceWorld("light", 120);
    createTimelineDirector(singleSegment(80), ENDLESS_CURVE).update(world, TICK_SEC);
    expect(world.difficulty.maxAlive).toBe(80);
    expect(world.difficulty.hpMul).toBe(1);
  });

  it("обычное устройство при желаемых 200 и потолке 400 добавки не получает", () => {
    const world = deviceWorld("standard", 120);
    createTimelineDirector(singleSegment(200), ENDLESS_CURVE).update(world, TICK_SEC);
    expect(world.difficulty.maxAlive).toBe(200);
    expect(world.difficulty.hpMul).toBe(1);
    expect(world.difficulty.damageMul).toBe(1);
  });

  it("обычное устройство тоже имеет потолок, и сверх него жёстче здоровье и урон", () => {
    const world = deviceWorld("standard", 120);
    createTimelineDirector(singleSegment(800), ENDLESS_CURVE).update(world, TICK_SEC);
    expect(world.difficulty.maxAlive).toBe(400);
    // shortfall = min(2, 800 / 400) = 2.
    expect(world.difficulty.hpMul).toBe(1.5);
  });

  it("потолок пула режет число живых, но добавки за устройство не даёт", () => {
    const world = deviceWorld("standard", 120, { config: { maxEnemies: 64 } });
    createTimelineDirector(singleSegment(200), ENDLESS_CURVE).update(world, TICK_SEC);
    expect(world.difficulty.maxAlive).toBe(64);
    expect(world.difficulty.hpMul).toBe(1);
    expect(world.difficulty.damageMul).toBe(1);
  });

  it("на слабом устройстве пул тоже режет: потолок — меньшее из двух", () => {
    const world = deviceWorld("light", 0, { config: { maxEnemies: 64 } });
    createTimelineDirector(singleSegment(200), ENDLESS_CURVE).update(world, TICK_SEC);
    expect(world.difficulty.maxAlive).toBe(64);
  });
});

describe("сдвиг ступеней", () => {
  const stages: EnemyStageDef[] = [
    { fromSec: 0, weight: 1, hpMul: 1, damageMul: 1, speedMul: 1, xpMul: 1 },
    { fromSec: 100, weight: 1, hpMul: 2, damageMul: 1.5, speedMul: 1, xpMul: 2 },
  ];

  /** Бросал ли выбор ступени генератор: пока открыта одна ступень, он не трогается вовсе. */
  function pickMovesGenerator(elapsedSec: number, shiftSec: number): boolean {
    const world = makePressureWorld({ stages, elapsedSec });
    world.difficulty.stageShiftSec = shiftSec;
    const before = world.rng.getState();
    pickStage(world);
    return world.rng.getState() !== before;
  }

  it("положительный сдвиг открывает вторую ступень раньше", () => {
    expect(pickMovesGenerator(60, 50)).toBe(true);
  });

  it("без сдвига вторая ступень на 60-й секунде закрыта", () => {
    expect(pickMovesGenerator(60, 0)).toBe(false);
  });

  it("отрицательный сдвиг оставляет вторую ступень закрытой дольше", () => {
    expect(pickMovesGenerator(120, -50)).toBe(false);
    expect(pickMovesGenerator(120, 0)).toBe(true);
  });

  it("отрицательная секунда не уходит в минус", () => {
    expect(pickMovesGenerator(10, -50)).toBe(false);
    const world = makePressureWorld({ stages, elapsedSec: 10 });
    world.difficulty.stageShiftSec = -50;
    expect(pickStage(world)).toBe(0);
  });
});

describe("сдвиг событий элит и боссов", () => {
  const curve: EndlessCurveDef = {
    fromSec: 0,
    segmentSec: 30,
    threatPerSec: 1,
    threatGrowth: 1,
    maxAlive: 100,
    hpGrowth: 1,
    damageGrowth: 1,
    pool: ["swarm_rat"],
    startTypes: 1,
    typesPerSegment: 0,
    mixSize: 1,
    events: [
      { everySegments: 3, kind: "ring", enemy: "elite_ghoul", count: 1 },
      { everySegments: 3, kind: "ring", enemy: "boss_matryoshka", count: 1 },
      { everySegments: 3, kind: "flank", enemy: "swarm_rat", count: 5 },
    ],
  };

  /** На каких шагах 0…9 кривой срабатывает событие этого врага при таких сдвигах. */
  function stepsOf(enemy: string, eliteLead: number, bossLead: number): number[] {
    const world = makePressureWorld();
    world.difficulty.eliteLead = eliteLead;
    world.difficulty.bossLead = bossLead;
    const steps: number[] = [];
    for (let step = 0; step < 10; step++) {
      const plan = planSegment(world, [], curve, step);
      if (plan.events.some((event) => world.enemyTypes[event.typeIndex].id === enemy)) steps.push(step);
    }
    return steps;
  }

  it("без сдвига — прежнее правило: шаги 2, 5, 8", () => {
    expect(stepsOf("elite_ghoul", 0, 0)).toEqual([2, 5, 8]);
    expect(stepsOf("boss_matryoshka", 0, 0)).toEqual([2, 5, 8]);
  });

  it("сдвиг на +1 приближает элиту на отрезок: шаги 1, 4, 7", () => {
    expect(stepsOf("elite_ghoul", 1, 0)).toEqual([1, 4, 7]);
  });

  it("сдвиг на −1 отодвигает элиту, а шаг 0 не срабатывает вовсе", () => {
    expect(stepsOf("elite_ghoul", -1, 0)).toEqual([3, 6, 9]);
  });

  it("боссы сдвигаются независимо от элит", () => {
    expect(stepsOf("boss_matryoshka", 1, 0)).toEqual([2, 5, 8]);
    expect(stepsOf("boss_matryoshka", 0, 1)).toEqual([1, 4, 7]);
    expect(stepsOf("elite_ghoul", 0, 1)).toEqual([2, 5, 8]);
  });

  it("события обычных врагов не двигаются при любом сдвиге", () => {
    for (const [elite, boss] of [[0, 0], [1, 1], [-1, 0], [1, 0]] as const) {
      expect(stepsOf("swarm_rat", elite, boss), `элита ${elite}, босс ${boss}`).toEqual([2, 5, 8]);
    }
  });

  it("расписанные руками отрезки не двигаются", () => {
    const manual: TimelineSegmentDef[] = [
      {
        fromSec: 0,
        spawns: [{ enemy: "swarm_rat", perSec: 1 }],
        events: [{ kind: "ring", enemy: "elite_ghoul", count: 1 }],
      },
    ];
    for (const lead of [-1, 0, 1]) {
      const world = makePressureWorld();
      world.difficulty.eliteLead = lead;
      world.difficulty.bossLead = Math.max(0, lead);
      const plan = planSegment(world, manual, curve, 0);
      expect(plan.events.map((event) => world.enemyTypes[event.typeIndex].id), `сдвиг ${lead}`).toEqual(["elite_ghoul"]);
    }
  });
});

describe("опорная сила и выключенная подстройка", () => {
  /** Сто пятьдесят секунд под настоящим таймлайном и тем же вводом. */
  function runWorld(world: World): void {
    const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
    for (let tick = 0; tick < 150 * 60; tick++) {
      director.update(world, TICK_SEC);
      stepWorld(world, { moveX: tick % 240 < 120 ? 1 : -1, moveY: tick % 360 < 180 ? 1 : 0 });
    }
  }

  it("ровно ничего не меняется, когда сила опорная", LONG_RUN, () => {
    const noRules = makePressureWorld({ pressure: null });
    // Сборка не влияет, пять слотов дают ровно reference 1,25, устройство обычное, потолок 400 выше желаемого.
    const rules = { ...TEST_PRESSURE, power: { ...TEST_PRESSURE.power, buildPoints: 0 } };
    const adjusted = makePressureWorld({ pressure: rules });
    expect(adjusted.difficulty.pressureLevel).toBe(1);

    runWorld(noRules);
    runWorld(adjusted);

    expect(checksumWorld(adjusted)).toBe(checksumWorld(noRules));
    expect(adjusted.stats.enemiesSpawned).toBe(noRules.stats.enemiesSpawned);
    expect(adjusted.rng.getState()).toBe(noRules.rng.getState());
  });

  it("без уровня аккаунта контент подстройки ничего не меняет, даже у сильного снаряжения", LONG_RUN, () => {
    const plain = makePressureWorld({ pressure: null, accountLevel: null, modifiers: { damage: 1 } });
    const withRules = makePressureWorld({ accountLevel: null, modifiers: { damage: 1 } });

    runWorld(plain);
    runWorld(withRules);

    expect(checksumWorld(withRules)).toBe(checksumWorld(plain));
    expect(withRules.stats.enemiesSpawned).toBe(plain.stats.enemiesSpawned);
    expect(withRules.rng.getState()).toBe(plain.rng.getState());
    expect(withRules.difficulty.spawnMul).toBe(1);
    expect(withRules.difficulty.stageShiftSec).toBe(0);
  });

  it("не трогает генератор мира ни при пересчёте, ни при применении к отрезку", () => {
    const world = strongWorld({ deviceClass: "light", elapsedSec: 120 });
    const before = world.rng.getState();
    // Отрезок без спавна: директор сам тянет генератор на выбросы и события, а здесь измеряется только подстройка.
    createTimelineDirector([{ fromSec: 0, maxAlive: 200, spawns: [] }], ENDLESS_CURVE).update(world, TICK_SEC);
    expect(world.difficulty.hpMul).toBeGreaterThan(1);
    expect(world.rng.getState()).toBe(before);
  });
});

describe("ориентиры контента", () => {
  const novice = (): World => makeContentWorld(1, {});
  const medium = (): World => makeContentWorld(8, MEDIUM_GEAR);
  const full = (boosts: string[] = []): World => makeContentWorld(14, FULL_GEAR, boosts);

  it("новичок: мягче опорного, 0,7–0,9", () => {
    const level = novice().difficulty.pressureLevel;
    expect(level).toBeGreaterThan(0.7);
    expect(level).toBeLessThan(0.9);
  });

  it("средний: около опорного, 0,95–1,05", () => {
    const level = medium().difficulty.pressureLevel;
    expect(level).toBeGreaterThan(0.95);
    expect(level).toBeLessThan(1.05);
  });

  it("полный арсенал: жёстче, 1,1–1,3, и бусты давление не поднимают (Р183)", () => {
    const bare = full();
    const boosted = full(["fury", "bulwark", "aegis"]);
    expect(bare.difficulty.pressureLevel).toBeGreaterThan(1.1);
    expect(bare.difficulty.pressureLevel).toBeLessThanOrEqual(1.3);
    expect(boosted.difficulty.pressureLevel).toBe(bare.difficulty.pressureLevel);
    expect(boosted.difficulty.power).toBe(bare.difficulty.power);
  });

  it("порядок сохраняется: новичок мягче среднего, средний мягче полного", () => {
    const levels = [novice(), medium(), full()].map((world) => world.difficulty.pressureLevel);
    expect(levels[0]).toBeLessThan(levels[1]);
    expect(levels[1]).toBeLessThan(levels[2]);
  });

  it("опорная сила лежит между очками новичка и полного арсенала", () => {
    expect(novice().difficulty.power).toBeLessThan(PRESSURE.reference);
    expect(full().difficulty.power).toBeGreaterThan(PRESSURE.reference);
  });
});
