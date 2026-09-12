import type { EnemyDef, LevelCurveDef, PassiveDef, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { chooseUpgrade, isAwaitingChoice, xpForLevel } from "../src/game/progression/levels";
import { SIM_EVENT } from "../src/game/sim/events";
import { spawnGem } from "../src/game/sim/gems";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { vectorLength } from "../src/game/sim/vector";
import {
  createWorld,
  DEFAULT_SIM_CONFIG,
  spawnEnemy,
  type CreateWorldOptions,
  type World,
} from "../src/game/sim/world";

// Оружие, опыт и выбор улучшений (docs/26-stage2-plan.md, WP2).

/** Игрок стартует в начале координат: мир бесконечен, центра канвы больше нет. */
const CENTER = 0;

const DUMMY: EnemyDef = { id: "dummy", hp: 400, speed: 0.001, damage: 0, xp: 3, pattern: "swarm" };
const BITER: EnemyDef = { id: "biter", hp: 400, speed: 0.001, damage: 10, xp: 3, pattern: "swarm" };
const FRAGILE: EnemyDef = { id: "fragile", hp: 1, speed: 0.001, damage: 0, xp: 5, pattern: "swarm" };

const text = { nameKey: "n", descriptionKey: "d" };

const SPARK: WeaponDef = {
  id: "spark",
  behavior: "projectile_nearest",
  ...text,
  starting: true,
  levels: [
    { damage: 10, cooldownSec: 0.5, projectiles: 1, projectileSpeed: 600, ttlSec: 2 },
    { damage: 20, cooldownSec: 0.5, projectiles: 1, projectileSpeed: 600, ttlSec: 2 },
  ],
};

const KNIFE: WeaponDef = {
  id: "knife",
  behavior: "projectile_facing",
  ...text,
  levels: [{ damage: 10, cooldownSec: 0.5, projectiles: 1, pierce: 1, projectileSpeed: 600, ttlSec: 2 }],
};

const WARD: WeaponDef = {
  id: "ward",
  behavior: "orbit",
  ...text,
  levels: [{ damage: 10, cooldownSec: 0.4, projectiles: 2, areaRadius: 100, projectileSpeed: 200 }],
};

const AURA: WeaponDef = {
  id: "aura",
  behavior: "aura",
  ...text,
  levels: [{ damage: 4, cooldownSec: 0.5, areaRadius: 120 }],
};

const STORM: WeaponDef = {
  id: "storm",
  behavior: "area_strike",
  ...text,
  levels: [{ damage: 15, cooldownSec: 1, projectiles: 1, areaRadius: 60 }],
};

const MIGHT: PassiveDef = { id: "might", ...text, stat: "damage", op: "mul", levels: [2] };
const VOLLEY: PassiveDef = { id: "volley", ...text, stat: "projectiles", op: "add", levels: [2] };
const WARD_PASSIVE: PassiveDef = { id: "ward_p", ...text, stat: "armor", op: "add", levels: [4] };
const VITALITY: PassiveDef = { id: "vitality", ...text, stat: "maxHp", op: "add", levels: [50] };

const FAST_CURVE: LevelCurveDef = { baseXp: 5, growth: 2 };

function setup(options: Partial<CreateWorldOptions> = {}): World {
  return createWorld({
    seed: 1,
    enemies: [DUMMY, BITER, FRAGILE],
    weapons: [SPARK],
    passives: [MIGHT, VOLLEY, WARD_PASSIVE, VITALITY],
    levelCurve: FAST_CURVE,
    loadoutLimits: { weapons: 2, passives: 2 },
    ...options,
    config: {
      player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 500 },
      ...options.config,
    },
  });
}

function typeIndex(world: World, id: string): number {
  return world.enemyTypes.findIndex((type) => type.id === id);
}

function place(world: World, id: string, dx: number, dy: number): number {
  const slot = spawnEnemy(world, typeIndex(world, id), CENTER + dx, CENTER + dy);
  if (slot < 0) throw new Error("Пул исчерпан при подготовке теста");
  return slot;
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

function hpOf(world: World, slot: number): number {
  return world.enemies.hp[slot];
}

describe("оружие", () => {
  it("стреляет само и бьёт ближайшего врага", () => {
    const world = setup();
    const near = place(world, "dummy", 120, 0);
    const far = place(world, "dummy", -280, 0);

    run(world, 60);

    expect(hpOf(world, near)).toBeLessThan(DUMMY.hp);
    expect(hpOf(world, far)).toBe(DUMMY.hp);
    expect(world.stats.shotsFired).toBeGreaterThan(0);
  });

  it("не тратит перезарядку, пока целей нет", () => {
    const world = setup();
    run(world, 120);
    expect(world.stats.shotsFired).toBe(0);

    place(world, "dummy", 100, 0);
    run(world, 2);

    expect(world.stats.shotsFired).toBe(1);
  });

  it("бьёт по направлению движения и сохраняет его на остановке", () => {
    const world = setup({ weapons: [{ ...KNIFE, starting: true }] });
    const behind = place(world, "dummy", -150, 0);

    for (let i = 0; i < 30; i++) stepWorld(world, { moveX: -1, moveY: 0 });

    expect(hpOf(world, behind)).toBeLessThan(DUMMY.hp);
  });

  it("пробивающий снаряд задевает нескольких врагов, но каждого один раз", () => {
    const world = setup({ weapons: [{ ...KNIFE, starting: true }] });
    const first = place(world, "dummy", -80, 0);
    const second = place(world, "dummy", -140, 0);
    const third = place(world, "dummy", -200, 0);

    for (let i = 0; i < 40; i++) stepWorld(world, { moveX: -1, moveY: 0 });

    // pierce: 1 — снаряд бьёт двоих и исчезает.
    expect(hpOf(world, first)).toBeLessThan(DUMMY.hp);
    expect(hpOf(world, second)).toBeLessThan(DUMMY.hp);
    expect(hpOf(world, third)).toBe(DUMMY.hp);
  });

  it("обереги кружат вокруг игрока и бьют то, чего касаются", () => {
    const world = setup({ weapons: [{ ...WARD, starting: true }] });
    const onRing = place(world, "dummy", 100, 0);
    const outside = place(world, "dummy", 400, 0);

    const before = world.loadout.weapons[0].dirX;
    run(world, 60);

    expect(world.loadout.weapons[0].dirX).not.toBe(before);
    expect(hpOf(world, onRing)).toBeLessThan(DUMMY.hp);
    expect(hpOf(world, outside)).toBe(DUMMY.hp);
  });

  it("аура бьёт всех в радиусе и никого снаружи", () => {
    const world = setup({ weapons: [{ ...AURA, starting: true }] });
    const inside = place(world, "dummy", 60, 0);
    const alsoInside = place(world, "dummy", -60, 60);
    const outside = place(world, "dummy", 300, 0);

    run(world, 60);

    expect(hpOf(world, inside)).toBeLessThan(DUMMY.hp);
    expect(hpOf(world, alsoInside)).toBeLessThan(DUMMY.hp);
    expect(hpOf(world, outside)).toBe(DUMMY.hp);
  });

  it("удар по площади дотягивается до дальнего врага и сообщает рендеру", () => {
    const world = setup({ weapons: [{ ...STORM, starting: true }] });
    const far = place(world, "dummy", 500, 0);

    run(world, 120);

    expect(hpOf(world, far)).toBeLessThan(DUMMY.hp);
    expect(world.events.written).toBeGreaterThan(0);
    expect(world.events.kind[0]).toBe(SIM_EVENT.strike);
  });

  it("считает урон по оружию — вход геймдизайнера для баланса", () => {
    const world = setup();
    place(world, "dummy", 100, 0);

    run(world, 60);

    expect(world.stats.damageByWeapon[0]).toBeGreaterThan(0);
    expect(world.stats.damageDealt).toBeCloseTo(world.stats.damageByWeapon[0], 5);
  });
});

describe("пассивки", () => {
  it("множитель урона удваивает урон оружия", () => {
    const plain = setup();
    place(plain, "dummy", 100, 0);
    run(plain, 60);

    const buffed = setup();
    place(buffed, "dummy", 100, 0);
    buffed.progression.offers = [
      { id: "passive_new:might:1", kind: "passive_new", refId: "might", level: 1, ...text },
    ];
    chooseUpgrade(buffed, "passive_new:might:1");
    run(buffed, 60);

    expect(buffed.stats.damageDealt).toBeCloseTo(plain.stats.damageDealt * 2, 5);
  });

  it("прибавка к снарядам увеличивает залп", () => {
    const world = setup();
    place(world, "dummy", 100, 0);
    world.progression.offers = [
      { id: "passive_new:volley:1", kind: "passive_new", refId: "volley", level: 1, ...text },
    ];
    chooseUpgrade(world, "passive_new:volley:1");

    run(world, 2);

    expect(world.stats.shotsFired).toBe(3);
  });

  it("живучесть поднимает и максимум, и текущее здоровье", () => {
    const world = setup();
    world.player.hp = 100;
    world.progression.offers = [
      { id: "passive_new:vitality:1", kind: "passive_new", refId: "vitality", level: 1, ...text },
    ];
    chooseUpgrade(world, "passive_new:vitality:1");

    expect(world.playerStats.maxHp).toBe(550);
    expect(world.player.hp).toBe(150);
  });

  it("броня снижает урон, но не делает неуязвимым", () => {
    const world = setup();
    world.progression.offers = [
      { id: "passive_new:ward_p:1", kind: "passive_new", refId: "ward_p", level: 1, ...text },
    ];
    chooseUpgrade(world, "passive_new:ward_p:1");

    const hpBefore = world.player.hp;
    place(world, "biter", 0, 0);
    run(world, 10);

    const taken = hpBefore - world.player.hp;
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(BITER.damage);
  });
});

describe("опыт и уровни", () => {
  it("роняет кристалл за убитого врага и начисляет опыт при подборе", () => {
    const world = setup();
    place(world, "fragile", 60, 0);

    run(world, 120);

    expect(world.stats.enemiesKilled).toBe(1);
    expect(world.stats.xpCollected).toBe(FRAGILE.xp);
  });

  it("сливает кристаллы при переполнении пула, не теряя опыт", () => {
    const world = setup({ config: { maxGems: 2, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 500 } } });
    // Кристаллы кладём далеко: иначе игрок подберёт их раньше, чем пул
    // заполнится, и слияние не проверится.
    for (let i = 0; i < 5; i++) spawnGem(world, CENTER + 900, CENTER, 2);

    let total = 0;
    for (let i = 0; i < world.gems.count; i++) {
      if (world.gems.alive[i] === 1) total += world.gems.value[i];
    }

    expect(world.gems.aliveCount).toBe(2);
    expect(total).toBe(10);
  });

  it("останавливает мир на выборе и продолжает после него", () => {
    const world = setup();
    place(world, "fragile", 60, 0);
    run(world, 180);

    expect(isAwaitingChoice(world)).toBe(true);
    const tickAtChoice = world.stats.tick;

    run(world, 30);
    expect(world.stats.tick).toBe(tickAtChoice);

    chooseUpgrade(world, world.progression.offers[0].id);
    run(world, 5);

    expect(world.stats.tick).toBeGreaterThan(tickAtChoice);
    expect(isAwaitingChoice(world)).toBe(false);
  });

  it("предлагает три разных варианта и повторяет их на том же seed", () => {
    const offersOf = (): string[] => {
      const world = setup();
      place(world, "fragile", 60, 0);
      run(world, 180);
      return world.progression.offers.map((offer) => offer.id);
    };

    const first = offersOf();
    expect(first).toHaveLength(3);
    expect(new Set(first).size).toBe(3);
    expect(offersOf()).toEqual(first);
  });

  it("не предлагает того, чего нельзя взять: слоты заняты, уровни на потолке", () => {
    const world = setup({
      weapons: [SPARK],
      passives: [MIGHT],
      loadoutLimits: { weapons: 1, passives: 0 },
    });
    // Оружие одно и уже на максимуме, пассивок некуда брать — остаётся
    // только лечение.
    world.loadout.weapons[0].level = SPARK.levels.length;
    world.player.hp = 100;
    place(world, "fragile", 60, 0);
    run(world, 180);

    expect(world.progression.offers).toHaveLength(1);
    expect(world.progression.offers[0].kind).toBe("heal");

    chooseUpgrade(world, world.progression.offers[0].id);
    expect(world.player.hp).toBeGreaterThan(100);
  });

  it("не принимает выбор, которого не предлагали", () => {
    const world = setup();
    place(world, "fragile", 60, 0);
    run(world, 180);

    expect(chooseUpgrade(world, "weapon_new:unknown:1")).toBe(false);
    expect(isAwaitingChoice(world)).toBe(true);
  });

  it("копит уровни в очередь, если опыта пришло сразу много", () => {
    const world = setup();
    spawnGem(world, world.player.x, world.player.y, 1000);

    run(world, 2);

    expect(world.progression.level).toBeGreaterThan(2);
    expect(world.progression.pendingLevelUps).toBeGreaterThan(1);

    const level = world.progression.level;
    chooseUpgrade(world, world.progression.offers[0].id);
    run(world, 1);

    // После первого выбора сразу предлагается следующий — уровни не теряются.
    expect(isAwaitingChoice(world)).toBe(true);
    expect(world.progression.level).toBe(level);
  });

  it("поднимает уровень оружия, а не заводит второе такое же", () => {
    const world = setup();
    place(world, "fragile", 60, 0);
    run(world, 180);

    world.progression.offers = [
      { id: "weapon_level:spark:2", kind: "weapon_level", refId: "spark", level: 2, ...text },
    ];
    chooseUpgrade(world, "weapon_level:spark:2");

    expect(world.loadout.weapons).toHaveLength(1);
    expect(world.loadout.weapons[0].level).toBe(2);
  });

  it("притягивает кристалл в радиусе подбора и не трогает дальний", () => {
    const world = setup();
    const near = world.playerStats.pickupRadius * 0.8;
    spawnGem(world, world.player.x + near, world.player.y, 1);
    spawnGem(world, world.player.x + world.playerStats.pickupRadius * 3, world.player.y, 1);

    run(world, 30);

    expect(world.stats.xpCollected).toBe(1);
    expect(world.gems.aliveCount).toBe(1);
  });

  it("считает порог опыта так же, как растёт кривая", () => {
    expect(xpForLevel(FAST_CURVE, 1)).toBe(5);
    expect(xpForLevel(FAST_CURVE, 2)).toBe(10);
    expect(xpForLevel(FAST_CURVE, 3)).toBe(20);
  });
});

describe("расстояние и позиция", () => {
  it("кристалл летит к игроку, а не стоит на месте", () => {
    const world = setup();
    spawnGem(world, world.player.x + world.playerStats.pickupRadius * 0.9, world.player.y, 1);
    const startDistance = vectorLength(world.gems.x[0] - world.player.x, world.gems.y[0] - world.player.y);

    run(world, 3);

    const distance = vectorLength(world.gems.x[0] - world.player.x, world.gems.y[0] - world.player.y);
    expect(distance).toBeLessThan(startDistance);
  });
});
