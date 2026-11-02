import type { BoostDef, EnemyDef, LimitDef, LoadoutStat, PassiveDef, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { LIMITS } from "../src/content/upgrades";
import { findLimitProblems, limitCandidates, limitModifiers } from "../src/game/progression/limit";
import { addPassive } from "../src/game/progression/loadout";
import { chooseUpgrade, OFFERS_PER_LEVEL, prepareOffers, refreshPlayerStats } from "../src/game/progression/levels";
import { LOADOUT_BOUNDS } from "../src/game/progression/run-loadout";
import { openChest } from "../src/game/sim/chests";
import { createRng } from "../src/game/sim/rng";
import { createWorld, DEFAULT_SIM_CONFIG, type CreateWorldOptions, type World } from "../src/game/sim/world";

// «Предел» (tasks/T-0194): когда прокачивать нечего, уровень даёт малые
// прибавки без конца, а лечение остаётся, пока здоровье просело.

const text = { nameKey: "n", descriptionKey: "d" };
const DUMMY: EnemyDef = { id: "dummy", hp: 400, speed: 0.001, damage: 0, xp: 3, pattern: "swarm" };

const SPARK: WeaponDef = {
  id: "spark",
  behavior: "projectile_nearest",
  ...text,
  levels: [
    { damage: 10, cooldownSec: 0.5, projectiles: 1, projectileSpeed: 600, ttlSec: 2 },
    { damage: 20, cooldownSec: 0.5, projectiles: 1, projectileSpeed: 600, ttlSec: 2 },
  ],
};
const MIGHT: PassiveDef = { id: "might", ...text, category: "attack", stat: "damage", op: "mul", levels: [2] };

const INSIGHT: BoostDef = { id: "insight", ...text, extraOffers: 1 };

/** Здоровье сто: «ниже половины» в тестах читается без пересчёта. */
const PLAYER = { ...DEFAULT_SIM_CONFIG.player, maxHp: 100 };

/** Единственное оружие на максимуме, пассивок нет: выбирать нечего, кроме «Предела». */
function setup(patch: Partial<CreateWorldOptions> = {}): World {
  const world = createWorld({
    seed: 7,
    enemies: [DUMMY],
    weapons: [SPARK],
    passives: [],
    levelCurve: { baseXp: 5, growth: 2 },
    loadoutLimits: { weapons: 1, passives: { attack: 0, defense: 0, mobility: 0 } },
    limits: LIMITS,
    ...patch,
    config: { player: PLAYER, ...patch.config },
  });
  world.loadout.weapons[0].level = SPARK.levels.length;
  world.progression.pendingLevelUps = 1;
  return world;
}

const ids = (world: World): string[] => world.progression.offers.map((offer) => offer.id);
const indexOf = (id: string): number => LIMITS.findIndex((def) => def.id === id);

/** Прибавки снаряжения, доведённые до предела движка, для заданных параметров. */
function maxed(stats: readonly LoadoutStat[]): Partial<CreateWorldOptions> {
  const modifiers: Partial<Record<LoadoutStat, number>> = {};
  for (const stat of stats) modifiers[stat] = LOADOUT_BOUNDS[stat];
  return { loadout: { modifiers, boosts: [] } };
}

/** Нажать «Предел» по id: карточка берётся у самого движка, а не собирается руками. */
function takeLimit(world: World, id: string): void {
  const candidate = limitCandidates(world).find((entry) => entry.option.id === `limit:${id}`);
  if (candidate === undefined) throw new Error(`нет кандидата limit:${id}`);
  world.progression.offers = [candidate.option];
  world.progression.pendingLevelUps = 1;
  expect(chooseUpgrade(world, candidate.option.id)).toBe(true);
}

describe("карточки «Предела»", () => {
  it("нечего улучшать, здоровье полное: три разные карточки из контента", () => {
    const world = setup();
    const offers = prepareOffers(world);

    expect(offers).toHaveLength(OFFERS_PER_LEVEL);
    expect(new Set(ids(world)).size).toBe(OFFERS_PER_LEVEL);
    for (const offer of offers) {
      expect(offer.kind).toBe("limit");
      expect(offer.id).toBe(`limit:${offer.refId}`);
      expect(LIMITS.map((def) => def.id)).toContain(offer.refId);
    }
  });

  it("пока есть что улучшать, карточки прежние: «Предела» среди них нет", () => {
    const world = setup();
    world.loadout.weapons[0].level = 1;
    const offers = prepareOffers(world);

    expect(offers.map((offer) => offer.kind)).toEqual(["weapon_level"]);
  });

  it("здоровье ниже половины: две карточки «Предела» и лечение 30% последним", () => {
    const world = setup();
    world.player.hp = 49;
    const offers = prepareOffers(world);

    expect(offers.map((offer) => offer.kind)).toEqual(["limit", "limit", "heal"]);
    expect(offers[2].changes).toEqual([
      { labelKey: "upgrade.stat.heal", from: null, to: 30, format: "value", lowerIsBetter: false },
    ]);
  });

  it("ровно половина здоровья — лечения среди карточек нет", () => {
    const world = setup();
    world.player.hp = 50;

    expect(prepareOffers(world).map((offer) => offer.kind)).toEqual(["limit", "limit", "limit"]);
  });

  it("лишняя карточка буста «Прозрение» — четвёртая", () => {
    const world = setup({ boosts: [INSIGHT], loadout: { modifiers: {}, boosts: ["insight"] } });

    expect(prepareOffers(world)).toHaveLength(OFFERS_PER_LEVEL + 1);
  });

  it("пул из двух записей — две карточки, остальные на пределе не предлагаются", () => {
    const world = setup(maxed(["damage", "cooldown", "area", "maxHp", "regenPerSec"]));
    const offers = prepareOffers(world);

    expect(ids(world).sort()).toEqual(["limit:pull", "limit:speed"]);
    expect(offers.every((offer) => offer.kind === "limit")).toBe(true);
  });

  it("все семь на пределе — одна карточка лечения, как раньше", () => {
    const world = setup(maxed(["damage", "cooldown", "area", "maxHp", "regenPerSec", "moveSpeed", "pickupRadius"]));

    expect(prepareOffers(world).map((offer) => offer.kind)).toEqual(["heal"]);
  });

  it("без записей в контенте мира выбор прежний: одно лечение", () => {
    const world = setup({ limits: [] });

    expect(prepareOffers(world).map((offer) => offer.kind)).toEqual(["heal"]);
  });
});

describe("нажатия «Предела»", () => {
  it("урон: три нажатия дают +9%, карточка показывает накопленное «было → стало»", () => {
    const world = setup();
    const slot = indexOf("damage");
    expect(world.progression.limitStacks).toHaveLength(LIMITS.length);

    takeLimit(world, "damage");
    takeLimit(world, "damage");
    const third = limitCandidates(world).find((entry) => entry.option.id === "limit:damage");
    expect(third?.option.level).toBe(3);
    expect(third?.option.changes).toEqual([
      { labelKey: "upgrade.stat.passive.damage", from: 1.06, to: 1.09, format: "percent", lowerIsBetter: false },
    ]);

    takeLimit(world, "damage");
    expect(world.progression.limitStacks[slot]).toBe(3);
    expect(world.playerStats.damageMul).toBeCloseTo(1.09, 10);
    expect(world.progression.pendingLevelUps).toBe(0);
  });

  it("навыки усиливают прибавку «Предела» сверху, как снаряжение", () => {
    const world = setup({
      passives: [MIGHT],
      loadoutLimits: { weapons: 1, passives: { attack: 1, defense: 0, mobility: 0 } },
    });
    addPassive(world.loadout, 0);
    refreshPlayerStats(world);
    expect(world.playerStats.damageMul).toBe(2);

    takeLimit(world, "damage");
    takeLimit(world, "damage");
    takeLimit(world, "damage");

    expect(world.playerStats.damageMul).toBeCloseTo(2 * 1.09, 10);
  });

  it("перезарядка: каждое нажатие укорачивает её на 2%, карточка помечена «меньше — лучше»", () => {
    const world = setup();
    const first = limitCandidates(world).find((entry) => entry.option.id === "limit:cooldown");
    expect(first?.option.changes).toEqual([
      { labelKey: "upgrade.stat.passive.cooldown", from: 1, to: 0.98, format: "percent", lowerIsBetter: true },
    ]);

    takeLimit(world, "cooldown");
    takeLimit(world, "cooldown");

    expect(world.playerStats.cooldownMul).toBeCloseTo(0.96, 10);
  });

  it("здоровье: максимум растёт на 10 за нажатие, текущее — на столько же", () => {
    const world = setup();
    world.player.hp = 60;

    takeLimit(world, "maxHp");

    expect(world.playerStats.maxHp).toBe(110);
    expect(world.player.maxHp).toBe(110);
    expect(world.player.hp).toBe(70);
  });

  it("восстановление и притяжение копятся своими шагами", () => {
    const world = setup();
    const basePull = world.playerStats.pickupRadius;

    takeLimit(world, "regen");
    takeLimit(world, "regen");
    takeLimit(world, "pull");

    expect(world.playerStats.regenPerSec).toBeCloseTo(0.2, 10);
    expect(world.playerStats.pickupRadius).toBeCloseTo(basePull * 1.05, 10);
  });

  it("прибавки снаряжения складываются с «Пределом»", () => {
    const world = setup({ loadout: { modifiers: { damage: 0.5 }, boosts: [] } });

    takeLimit(world, "damage");

    expect(world.playerStats.damageMul).toBeCloseTo(1.53, 10);
  });

  it("лечение из карточек даёт 30% максимума и не трогает пул «Предела»", () => {
    const world = setup();
    world.player.hp = 20;
    prepareOffers(world);
    const heal = world.progression.offers.find((offer) => offer.kind === "heal");
    if (heal === undefined) throw new Error("лечения нет среди карточек");

    expect(chooseUpgrade(world, heal.id)).toBe(true);

    expect(world.player.hp).toBe(50);
    expect(world.progression.limitStacks.every((count) => count === 0)).toBe(true);
  });
});

describe("пределы движка", () => {
  it("тысяча нажатий не выводит прибавку за LOADOUT_BOUNDS, а запись на пределе не предлагается", () => {
    const world = setup();
    world.progression.limitStacks[indexOf("damage")] = 1000;
    refreshPlayerStats(world);

    expect(world.playerStats.damageMul).toBeCloseTo(1 + LOADOUT_BOUNDS.damage, 10);
    expect(limitCandidates(world).map((entry) => entry.option.id)).not.toContain("limit:damage");
  });

  it("с учётом снаряжения: запись исчезает, когда ещё одна стопка перешагнула бы предел", () => {
    // 2,95 + 0,03 = 2,98 влезает под 3, а 2,98 + 0,03 — нет.
    const world = setup({ loadout: { modifiers: { damage: 2.95 }, boosts: [] } });
    expect(limitCandidates(world).map((entry) => entry.option.id)).toContain("limit:damage");

    takeLimit(world, "damage");

    expect(limitCandidates(world).map((entry) => entry.option.id)).not.toContain("limit:damage");
    expect(world.playerStats.damageMul).toBeLessThanOrEqual(1 + LOADOUT_BOUNDS.damage);
  });

  it("limitModifiers: стопки по записям, лишние стопки без записи игнорируются", () => {
    const defs: LimitDef[] = [
      { id: "a", ...text, stat: "damage", step: 0.03 },
      { id: "b", ...text, stat: "maxHp", step: 10 },
    ];

    expect(limitModifiers([3, 2], defs)).toEqual({ damage: expect.closeTo(0.09, 10), maxHp: 20 });
    expect(limitModifiers([0, 0], defs)).toEqual({});
    expect(limitModifiers([1], defs)).toEqual({ damage: 0.03 });
  });
});

describe("случайность «Предела»", () => {
  it("тот же seed и те же действия дают те же карточки", () => {
    const offersOf = (seed: number): string[] => {
      const world = setup({ seed });
      prepareOffers(world);
      return ids(world);
    };

    expect(offersOf(11)).toEqual(offersOf(11));
    const seen = new Set([1, 2, 3, 4, 5, 6].map((seed) => offersOf(seed).join()));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("генератор мира сдвигается ровно на число вытянутых карточек", () => {
    const world = setup();
    const before = world.rng.getState();
    prepareOffers(world);

    const probe = createRng(0);
    probe.setState(before);
    for (let i = 0; i < OFFERS_PER_LEVEL; i++) probe.nextFloat();
    expect(world.rng.getState()).toBe(probe.getState());
  });

  it("лечение генератор не трогает: при низком здоровье вытянуто на карточку меньше", () => {
    const world = setup();
    world.player.hp = 10;
    const before = world.rng.getState();
    prepareOffers(world);

    const probe = createRng(0);
    probe.setState(before);
    for (let i = 0; i < OFFERS_PER_LEVEL - 1; i++) probe.nextFloat();
    expect(world.rng.getState()).toBe(probe.getState());
  });

  it("одно лечение, когда пул пуст, — без единого броска", () => {
    const world = setup({ limits: [] });
    const before = world.rng.getState();
    prepareOffers(world);

    expect(world.rng.getState()).toBe(before);
  });
});

describe("сундук без прокачки", () => {
  it("выдаёт опыт или аптечку, ни одной награды «Предел»", () => {
    const full = setup({ chests: CHESTS });
    openChest(full, 5);
    const hurt = setup({ chests: CHESTS });
    hurt.player.hp = 5;
    openChest(hurt, 5);

    const kinds = [...full.chests.openings, ...hurt.chests.openings].flatMap((opening) =>
      opening.rewards.map((reward) => reward.kind),
    );
    expect(kinds).toHaveLength(10);
    expect(kinds).not.toContain("limit");
    expect(new Set(kinds)).toEqual(new Set(["xp", "heal"]));
    expect(full.progression.limitStacks.every((count) => count === 0)).toBe(true);
  });
});

describe("проверка записей «Предела»", () => {
  const good: LimitDef = { id: "damage", ...text, stat: "damage", step: 0.03 };

  it("боевой список проходит проверку", () => {
    expect(findLimitProblems(LIMITS)).toEqual([]);
  });

  it("ловит нулевой и отрицательный шаг", () => {
    expect(findLimitProblems([{ ...good, step: 0 }]).join("\n")).toContain("damage");
    expect(findLimitProblems([{ ...good, step: -0.03 }])).not.toEqual([]);
  });

  it("ловит неизвестный параметр", () => {
    const bad = { ...good, stat: "bogus" } as unknown as LimitDef;
    expect(findLimitProblems([bad]).join("\n")).toContain("bogus");
  });

  it("ловит шаг больше 5% предела параметра", () => {
    // Предел урона 3: пять процентов — 0,15.
    expect(findLimitProblems([{ ...good, step: 0.15 }])).toEqual([]);
    expect(findLimitProblems([{ ...good, step: 0.16 }])).not.toEqual([]);
  });

  it("ловит повтор id", () => {
    const problems = findLimitProblems([good, { ...good, stat: "area" }]);
    expect(problems.join("\n")).toContain("повторяется");
  });

  it("ловит вес не больше нуля", () => {
    expect(findLimitProblems([{ ...good, weight: 0 }])).not.toEqual([]);
  });
});
