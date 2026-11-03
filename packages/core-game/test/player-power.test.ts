import { describe, expect, it } from "vitest";
import { addPassive, addWeapon } from "../src/game/progression/loadout";
import { buildScoreOf, computePlayerPower, expectedBuildScore } from "../src/game/sim/player-power";
import { describePressureResult, describePressureStart, isPressureActive } from "../src/game/sim/pressure";
import type { World } from "../src/game/sim/world";
import { makePressureWorld, REFERENCE_LIMITS, TEST_PRESSURE } from "./helpers/pressure-fixture";

// Сила игрока (tasks/T-0195, решение 4, Р65, Р183): сумма очков из слотов,
// снаряжения и отставания набора от расписания.

/**
 * Набор забит до отказа: в каждый слот встаёт тип с самым длинным запасом
 * уровней и уровень выставляется максимальным. Сумма уровней при этом не
 * меньше ёмкости (среднее не выше наибольшего), поэтому доля равна единице.
 */
function fillBuild(world: World): void {
  const limits = world.loadoutLimits;
  const passiveSlots = limits.passives.attack + limits.passives.defense + limits.passives.mobility;
  world.loadout.weapons.length = 0;
  world.loadout.passives.length = 0;
  const weapons = world.weaponTypes.map((type, index) => ({ index, levels: type.levels.length })).sort((a, b) => b.levels - a.levels);
  for (const { index, levels } of weapons.slice(0, limits.weapons)) addWeapon(world.loadout, index).level = levels;
  const passives = world.passiveTypes.map((type, index) => ({ index, levels: type.levels.length })).sort((a, b) => b.levels - a.levels);
  for (const { index, levels } of passives.slice(0, passiveSlots)) addPassive(world.loadout, index).level = levels;
}

describe("сила игрока: слоты", () => {
  it("считает очки за все слоты: оружие и три категории навыков", () => {
    const base = makePressureWorld({ limits: { weapons: 2, passives: { attack: 1, defense: 1, mobility: 1 } } });
    expect(computePlayerPower(base, TEST_PRESSURE).slots).toBe(1.25);

    const wide = makePressureWorld({ limits: { weapons: 4, passives: { attack: 3, defense: 2, mobility: 1 } } });
    expect(computePlayerPower(wide, TEST_PRESSURE).slots).toBe(2.5);
  });
});

describe("сила игрока: снаряжение", () => {
  it("складывает вес на прибавку по каждому параметру", () => {
    const world = makePressureWorld({ modifiers: { damage: 0.1, maxHp: 16 } });
    expect(computePlayerPower(world, TEST_PRESSURE).gear).toBeCloseTo(1.1, 12);
  });

  it("параметр без веса и нулевая прибавка в сумму не входят", () => {
    const world = makePressureWorld({ modifiers: { cooldown: 0.3, area: 1, armor: 5, damage: 0 } });
    expect(computePlayerPower(world, TEST_PRESSURE).gear).toBe(0);
  });

  it("без снаряжения очков снаряжения нет", () => {
    expect(computePlayerPower(makePressureWorld(), TEST_PRESSURE).gear).toBe(0);
  });

  it("бусты в силу не входят (Р183): те же очки и тот же уровень давления", () => {
    const plain = makePressureWorld({ modifiers: { damage: 0.1, maxHp: 16 } });
    const boosted = makePressureWorld({ modifiers: { damage: 0.1, maxHp: 16 }, boosts: ["fury", "aegis", "head_start", "insight"] });

    // Прибавка буста «Ярость» действительно в мире: она лежит в итоговых модификаторах, но не в силе.
    expect(boosted.loadoutModifiers.damage).toBeGreaterThan(plain.loadoutModifiers.damage ?? 0);
    expect(boosted.boosts.shieldHits).toBeGreaterThan(0);
    expect(boosted.boosts.startLevels).toBeGreaterThan(0);
    expect(boosted.boosts.extraOffers).toBeGreaterThan(0);

    expect(computePlayerPower(boosted, TEST_PRESSURE)).toEqual(computePlayerPower(plain, TEST_PRESSURE));
    expect(boosted.difficulty.pressureLevel).toBe(plain.difficulty.pressureLevel);
    expect(boosted.difficulty.power).toBe(plain.difficulty.power);
  });

  it("берёт снаряжение из набора забега, а не из итоговых модификаторов", () => {
    const world = makePressureWorld({ modifiers: { damage: 0.5 } });
    world.loadoutModifiers = { ...world.loadoutModifiers, damage: 9 };
    expect(computePlayerPower(world, TEST_PRESSURE).gear).toBe(0.5);
  });
});

describe("сила игрока: собранное в забеге", () => {
  it("на старте не даёт ничего: впереди или вровень с расписанием — ноль, а не бонус", () => {
    const world = makePressureWorld();
    const power = computePlayerPower(world, TEST_PRESSURE);
    expect(power.build).toBe(0);
    expect(Object.is(power.build, 0)).toBe(true);
  });

  it("набор впереди расписания давление не поднимает (Р183)", () => {
    const world = makePressureWorld({ elapsedSec: 50 });
    fillBuild(world);
    expect(buildScoreOf(world)).toBe(1);
    // На 50-й секунде ожидаемая доля 0,25, а собрано всё: ноль, а не +0,5.
    const power = computePlayerPower(world, TEST_PRESSURE);
    expect(power.build).toBe(0);
    expect(Object.is(power.build, 0)).toBe(true);
  });

  it("отстающему помогает, но не больше потолка", () => {
    const world = makePressureWorld({ elapsedSec: 200 });
    // Одно оружие первого уровня на 200-й секунде, где ожидается полный набор: помощь упирается в потолок.
    expect(world.loadout.weapons).toHaveLength(1);
    expect(computePlayerPower(world, TEST_PRESSURE).build).toBe(-0.5);
  });

  it("помощь растёт вместе с отставанием: на четверть позади — четверть очка", () => {
    const world = makePressureWorld({ elapsedSec: 150, limits: { weapons: 1, passives: { attack: 0, defense: 0, mobility: 0 } } });
    // Ёмкость — одно оружие: доля линейна по уровню, поэтому половину набора выставляем уровнем.
    world.loadout.weapons[0].level = 0.5 / buildScoreOf(world);
    expect(buildScoreOf(world)).toBeCloseTo(0.5, 12);
    // Ожидается 0,75, собрано 0,5.
    expect(computePlayerPower(world, TEST_PRESSURE).build).toBeCloseTo(-0.25, 12);
  });

  it("доля набора — от ёмкости слотов: один уровень из многих меньше единицы и не отрицательна", () => {
    const world = makePressureWorld();
    const score = buildScoreOf(world);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.5);
  });

  it("ломаная расписания: до первой точки, на точке, между точками, после последней", () => {
    const schedule = TEST_PRESSURE.power.buildSchedule;
    expect(expectedBuildScore(schedule, -5)).toBe(0);
    expect(expectedBuildScore(schedule, 0)).toBe(0);
    expect(expectedBuildScore(schedule, 100)).toBe(0.5);
    expect(expectedBuildScore(schedule, 150)).toBe(0.75);
    expect(expectedBuildScore(schedule, 200)).toBe(1);
    expect(expectedBuildScore(schedule, 900)).toBe(1);
    // Расписание, которое начинается не с нуля: до первой точки — её значение.
    expect(expectedBuildScore([[10, 0.25], [20, 0.5]], 5)).toBe(0.25);
  });

  it("пустой список типов оружия и навыков не даёт деления на ноль", () => {
    const world = makePressureWorld({ noTypes: true });
    const score = buildScoreOf(world);
    expect(Number.isFinite(score)).toBe(true);
    expect(Number.isFinite(computePlayerPower(world, TEST_PRESSURE).total)).toBe(true);
  });
});

describe("сила игрока: чистота", () => {
  it("не трогает генератор мира и даёт одно и то же при повторе", () => {
    const world = makePressureWorld({ modifiers: { damage: 0.2 }, elapsedSec: 120 });
    const before = world.rng.getState();
    const first = computePlayerPower(world, TEST_PRESSURE);
    const second = computePlayerPower(world, TEST_PRESSURE);
    expect(world.rng.getState()).toBe(before);
    expect(second).toEqual(first);
  });

  it("итог — сумма трёх слагаемых", () => {
    const world = makePressureWorld({ modifiers: { damage: 0.5 }, elapsedSec: 200, limits: REFERENCE_LIMITS });
    const power = computePlayerPower(world, TEST_PRESSURE);
    expect(power.total).toBe(power.slots + power.gear + power.build);
  });
});

describe("подстройка выключена", () => {
  it("без уровня аккаунта она не включается, а забег не несёт её следа", () => {
    const world = makePressureWorld({ accountLevel: null, modifiers: { damage: 1 } });
    expect(isPressureActive(world)).toBe(false);
    expect(describePressureStart(world)).toBeUndefined();
    expect(describePressureResult(world)).toBeUndefined();
    expect(world.difficulty.pressureLevel).toBe(1);
    expect(world.difficulty.power).toBe(0);
  });

  it("без контента подстройки она не включается, даже при уровне аккаунта", () => {
    const world = makePressureWorld({ pressure: null });
    expect(world.pressureRules).toBeNull();
    expect(isPressureActive(world)).toBe(false);
    expect(describePressureStart(world)).toBeUndefined();
    expect(describePressureResult(world)).toBeUndefined();
  });

  it("с уровнем и контентом включается и считает силу на старте", () => {
    const world = makePressureWorld();
    expect(isPressureActive(world)).toBe(true);
    expect(world.difficulty.power).toBe(1.25);
    expect(world.difficulty.startPower).toBe(1.25);
    expect(world.difficulty.pressureLevel).toBe(1);
  });
});
