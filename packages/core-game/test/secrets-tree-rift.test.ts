import type { EndlessCurveDef, EnemyDef, SecretsDef, TimelineSegmentDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { SECRETS } from "../src/content/secrets";
import { contentSnapshotSchema } from "../src/content/snapshot-schema";
import { CONTENT_SNAPSHOT } from "../src/content/snapshot";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENDLESS_CURVE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { isElite } from "../src/game/patterns/enemy-types";
import { captureWorld, restoreWorld, SnapshotError } from "../src/game/run/snapshot";
import { damageEnemy } from "../src/game/sim/combat";
import { applyContinue } from "../src/game/sim/continue";
import { findSecretsProblems, secretKindsFound, secretKindsUsed, takeSecretEvents } from "../src/game/sim/secrets";
import type { Spawner } from "../src/game/sim/spawner";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, despawnEnemy, NO_OWNER_TYPE, spawnEnemy, TICK_SEC, type SecretSite, type World } from "../src/game/sim/world";

// Древо-оберег и разлом Нави (docs/35-stage4-plan.md, Р153; tasks/T-0259):
// два тайника дальних колец с выбором «рискнуть или нет». Древо лечит и раз в
// минуту даёт щит, пока игрок рядом; разлом выпускает волну элит и отдаёт
// большой сундук за победу. Случайность — только из потока тайников.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
/**
 * Элита почти неподвижна: она стоит там, где вышла, и не бьёт игрока. Здоровья столько, что оружие игрока
 * не добьёт её за срок разлома, — убивает тест.
 */
const ELITE: EnemyDef = { id: "elite", hp: 1_000_000, speed: 0.001, damage: 0, xp: 5, pattern: "swarm", rank: "elite" };
const ELITE_B: EnemyDef = { ...ELITE, id: "elite_b" };
const ELITE_C: EnemyDef = { ...ELITE, id: "elite_c" };

/** Таймлайн: первая элита на 100-й секунде, вторая на 200-й, третья — кривая бесконечного режима на 360-й. */
const TIMELINE: TimelineSegmentDef[] = [
  { fromSec: 0, spawns: [{ enemy: "grunt", perSec: 1 }] },
  { fromSec: 100, spawns: [{ enemy: "grunt", perSec: 1 }], events: [{ kind: "ring", enemy: "elite", count: 1 }] },
  { fromSec: 200, spawns: [{ enemy: "grunt", perSec: 1 }], events: [{ kind: "flank", enemy: "elite_b", count: 1 }] },
];
const CURVE: EndlessCurveDef = {
  ...ENDLESS_CURVE,
  fromSec: 300,
  segmentSec: 60,
  events: [{ everySegments: 2, kind: "ring", enemy: "elite_c", count: 1 }],
};

const RING = { minRadius: 700, maxRadius: 1_100 };
const TICKS_PER_SEC = 60;

function rules(patch: Partial<SecretsDef>): SecretsDef {
  return { ...SECRETS, ...patch };
}

const ONLY_TREE = rules({ rings: [{ ...RING, count: 1, kinds: [{ kind: "tree", weight: 1 }] }] });
const ONLY_RIFT = rules({ rings: [{ ...RING, count: 1, kinds: [{ kind: "rift", weight: 1 }] }] });

function setup(secrets: SecretsDef, seed = 1, maxEnemies?: number): World {
  return createWorld({
    seed,
    enemies: [GRUNT, ELITE, ELITE_B, ELITE_C],
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: CHESTS,
    secrets,
    timeline: TIMELINE,
    endlessCurve: CURVE,
    ...(maxEnemies === undefined ? {} : { config: { maxEnemies } }),
  });
}

/** Спавнер без состояния: снимку нужен только он, а директор тест не интересует. */
const IDLE_SPAWNER: Spawner = { update() {} };

/** Перенести мир на секунду забега: тайники читают время из счётчика тиков. */
function atSec(world: World, sec: number): void {
  world.stats.tick = Math.round(sec / TICK_SEC);
  world.stats.elapsedSec = sec;
}

/** Мир, восстановленный из снимка другого: тот же seed и контент, как у продолженного забега. */
function restored(world: World, seed = 1): World {
  const next = setup(ONLY_RIFT, seed);
  restoreWorld(next, IDLE_SPAWNER, JSON.parse(JSON.stringify(captureWorld(world, IDLE_SPAWNER))));
  return next;
}

function standAt(world: World, x: number, y: number): void {
  const player = world.player;
  player.x = x;
  player.y = y;
  player.prevX = x;
  player.prevY = y;
  player.vx = 0;
  player.vy = 0;
}

function siteOf(world: World, kind: "tree" | "rift"): SecretSite {
  const site = world.secrets.sites.find((candidate) => candidate.kind === kind);
  if (site === undefined) throw new Error(`в раскладке нет тайника ${kind}`);
  return site;
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

function eliteSlots(world: World): number[] {
  const slots: number[] = [];
  for (let i = 0; i < world.enemies.count; i++) {
    if (world.enemies.alive[i] === 1 && isElite(world.enemyTypes[world.enemies.type[i]])) slots.push(i);
  }
  return slots;
}

/** Какие типы элит сейчас на поле. */
function eliteIds(world: World): Set<string> {
  return new Set(eliteSlots(world).map((slot) => world.enemyTypes[world.enemies.type[slot]].id));
}

function kill(world: World, slot: number): void {
  damageEnemy(world, slot, 1e9, NO_OWNER_TYPE);
}

describe("древо-оберег", () => {
  // Масштаб мира в этих тестах единичный: радиус из контента равен радиусу в мире.
  const radius = (): number => ONLY_TREE.tree.radius;

  it("в радиусе лечит долей здоровья в секунду; вне радиуса не лечит", () => {
    const world = setup(ONLY_TREE);
    const tree = siteOf(world, "tree");
    world.player.hp = world.player.maxHp / 2;
    const before = world.player.hp;

    standAt(world, tree.x + radius() + 5, tree.y);
    run(world, 2 * TICKS_PER_SEC);
    expect(world.player.hp).toBe(before);

    standAt(world, tree.x + radius() - 5, tree.y);
    run(world, TICKS_PER_SEC);
    const healed = world.player.hp - before;
    expect(healed).toBeCloseTo(world.player.maxHp * ONLY_TREE.tree.healPerSec, 1);
    expect(healed).toBeGreaterThan(0);
  });

  it("не лечит выше максимума здоровья", () => {
    const world = setup(ONLY_TREE);
    const tree = siteOf(world, "tree");
    standAt(world, tree.x, tree.y);
    run(world, 3 * TICKS_PER_SEC);
    expect(world.player.hp).toBe(world.player.maxHp);
  });

  it("раз в период, пока игрок в радиусе, даёт щит на одно попадание", () => {
    const world = setup(ONLY_TREE);
    const tree = siteOf(world, "tree");
    standAt(world, tree.x, tree.y);
    const period = ONLY_TREE.tree.shieldEverySec * TICKS_PER_SEC;

    run(world, period - 1);
    expect(world.player.shieldHits).toBe(0);
    run(world, 1);
    expect(world.player.shieldHits).toBe(1);
    // Щит не копится: непотраченный остаётся одним, а не растёт каждую минуту.
    run(world, period);
    expect(world.player.shieldHits).toBe(1);
  });

  it("отошёл — отсчёт щита идёт с нуля, лечение прекращается", () => {
    const world = setup(ONLY_TREE);
    const tree = siteOf(world, "tree");
    const period = ONLY_TREE.tree.shieldEverySec * TICKS_PER_SEC;

    standAt(world, tree.x, tree.y);
    run(world, period - 10);
    standAt(world, tree.x + 10 * radius(), tree.y);
    run(world, 30);
    standAt(world, tree.x, tree.y);
    run(world, 20);
    // Накопленное до ухода сгорело: через 20 тиков после возвращения щита ещё нет.
    expect(world.player.shieldHits).toBe(0);
    run(world, period);
    expect(world.player.shieldHits).toBe(1);
  });

  it("не исчезает: находка один раз, а через несколько минут лечит так же; в «использованных» его нет", () => {
    const world = setup(ONLY_TREE);
    const tree = siteOf(world, "tree");
    standAt(world, tree.x, tree.y);
    run(world, 5 * TICKS_PER_SEC);
    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.found.map((event) => event.kind)).toEqual(["tree"]);
    expect(events.used).toEqual([]);

    world.player.hp = world.player.maxHp / 2;
    const before = world.player.hp;
    run(world, 4 * 60 * TICKS_PER_SEC);
    expect(world.player.hp).toBeGreaterThan(before);
    expect(tree.used).toBe(false);
    // Огонёк на 90-й секунде тоже «найден»: он появился у игрока.
    expect(secretKindsFound(world)).toEqual(["tree", "wisp"]);
    expect(secretKindsUsed(world)).toEqual([]);
  });
});

describe("разлом Нави", () => {
  const WAVE = ONLY_RIFT.rift.elites;
  const LIMIT_TICKS = ONLY_RIFT.rift.timeLimitSec * TICKS_PER_SEC;
  const rift = (world: World): SecretSite => siteOf(world, "rift");
  const used = (world: World): string[][] =>
    takeSecretEvents(world, { found: 0, used: 0, blessings: 0 }).used.map((event) => [event.kind, event.outcome]);

  /** Войти в круг разлома на заданной секунде забега: по умолчанию — когда таймлайн выпустил первую элиту. */
  function open(world: World, sec = 150): void {
    atSec(world, sec);
    const site = rift(world);
    standAt(world, site.x, site.y);
    run(world, 2);
  }

  it("вход в радиус выпускает волну элит кольцом заданного радиуса вокруг разлома, мимо потолка живых", () => {
    const world = setup(ONLY_RIFT);
    // Потолок живых — единица: волна его не спрашивает.
    world.difficulty.maxAlive = 1;
    const site = rift(world);
    expect(eliteSlots(world)).toEqual([]);

    open(world);
    const slots = eliteSlots(world);
    expect(slots).toHaveLength(WAVE);
    const unit = world.config.unitScale;
    for (const slot of slots) {
      const distance = Math.hypot(world.enemies.x[slot] - site.x, world.enemies.y[slot] - site.y);
      expect(distance).toBeGreaterThan(ONLY_RIFT.rift.ringRadius * unit * 0.99);
      expect(distance).toBeLessThan(ONLY_RIFT.rift.ringRadius * unit * 1.01);
    }
    expect(rift(world).opened).toBe(true);
    // К 150-й секунде появился и огонёк: он «найден» сам собой.
    expect(secretKindsFound(world)).toEqual(["rift", "wisp"]);
    expect(secretKindsUsed(world)).toEqual([]);
  });

  it("убиты все — большой сундук и исход cleared; убитых меньше — ничего", () => {
    const world = setup(ONLY_RIFT);
    open(world);
    const slots = eliteSlots(world);

    for (const slot of slots.slice(0, WAVE - 1)) kill(world, slot);
    run(world, 2);
    expect(world.chests.openings).toHaveLength(0);
    expect(rift(world).used).toBe(false);

    kill(world, slots[WAVE - 1]);
    run(world, 2);
    expect(world.chests.openings.map((opening) => opening.size)).toEqual([ONLY_RIFT.rift.chestSize]);
    expect(rift(world).used).toBe(true);
    expect(used(world)).toEqual([["rift", "cleared"]]);
  });

  it("срок вышел, а элита жива, — сундука нет, исход left; после этого добитая волна ничего не даёт", () => {
    const world = setup(ONLY_RIFT);
    open(world);
    const site = rift(world);
    const slots = eliteSlots(world);
    kill(world, slots[0]);

    run(world, LIMIT_TICKS - 10);
    expect(site.used).toBe(false);
    expect(world.chests.openings).toHaveLength(0);

    run(world, 20);
    expect(site.used).toBe(true);
    expect(used(world)).toEqual([["rift", "left"]]);

    for (const slot of slots.slice(1)) kill(world, slot);
    run(world, 2);
    expect(world.chests.openings).toHaveLength(0);
    expect(used(world)).toEqual([["rift", "left"]]);
  });

  it("уход от разлома срока не меняет: отошёл далеко, но не добил — волна идёт до срока, а не закрывается сразу", () => {
    const world = setup(ONLY_RIFT);
    open(world);
    const site = rift(world);
    standAt(world, site.x + 20 * ONLY_RIFT.rift.ringRadius * world.config.unitScale, site.y);
    run(world, 5 * TICKS_PER_SEC);
    expect(site.used).toBe(false);
    expect(used(world)).toEqual([]);
  });

  it("убили всех в последнюю секунду срока — сундук, а не left", () => {
    const world = setup(ONLY_RIFT);
    open(world);
    run(world, LIMIT_TICKS - 30);
    for (const slot of eliteSlots(world)) kill(world, slot);
    run(world, 2);
    expect(used(world)).toEqual([["rift", "cleared"]]);
    expect(world.chests.openings).toHaveLength(1);
  });

  it("закрывается: повторный вход ни волны, ни сундука не даёт", () => {
    const world = setup(ONLY_RIFT);
    open(world);
    for (const slot of eliteSlots(world)) kill(world, slot);
    run(world, 2);
    const opened = world.chests.openings.length;
    const spawned = world.stats.enemiesSpawned;

    const site = rift(world);
    standAt(world, site.x + 500, site.y);
    run(world, 2);
    standAt(world, site.x, site.y);
    run(world, 10);
    expect(eliteSlots(world)).toEqual([]);
    expect(world.stats.enemiesSpawned).toBe(spawned);
    expect(world.chests.openings).toHaveLength(opened);
  });

  it("одна волна: стояние в круге после входа не выпускает вторую", () => {
    const world = setup(ONLY_RIFT);
    open(world);
    run(world, 5 * TICKS_PER_SEC);
    expect(eliteSlots(world).length).toBeLessThanOrEqual(WAVE);
    expect(world.stats.enemiesSpawned).toBe(WAVE);
  });

  it("состав и места волны берутся из потока тайников: world.rng не тронут", () => {
    const withRift = setup(ONLY_RIFT, 5);
    const without = setup(rules({ rings: [] }), 5);
    const site = rift(withRift);
    for (const world of [withRift, without]) {
      atSec(world, 250);
      standAt(world, site.x, site.y);
      stepWorld(world, IDLE_INPUT);
    }
    expect(eliteSlots(withRift)).toHaveLength(WAVE);
    expect(withRift.rng.getState()).toBe(without.rng.getState());
  });

  describe("пул волны: элиты, которые таймлайн уже выпускал", () => {
    /** Типы элит, вышедших из разлома, открытого на секунде `sec`, по нескольким seed. */
    function seen(sec: number): Set<string> {
      const ids = new Set<string>();
      for (let seed = 1; seed <= 12; seed++) {
        const world = setup(ONLY_RIFT, seed);
        open(world, sec);
        for (const id of eliteIds(world)) ids.add(id);
      }
      return ids;
    }

    it("разлом открыт до первой элиты таймлайна — выходит первая элита таймлайна", () => {
      expect([...seen(0)]).toEqual(["elite"]);
      expect([...seen(99)]).toEqual(["elite"]);
    });

    it("после первой элиты — она; вторая добавляется, когда таймлайн её выпустил", () => {
      expect([...seen(100)]).toEqual(["elite"]);
      expect([...seen(199)]).toEqual(["elite"]);
      expect([...seen(200)].sort()).toEqual(["elite", "elite_b"]);
      expect([...seen(300)].sort()).toEqual(["elite", "elite_b"]);
    });

    it("после ручных отрезков к пулу добавляются элиты событий кривой — с секунды их первого события", () => {
      // Событие раз в два отрезка: первое — на втором отрезке кривой, 300 + 60.
      expect([...seen(359)].sort()).toEqual(["elite", "elite_b"]);
      expect([...seen(360)].sort()).toEqual(["elite", "elite_b", "elite_c"]);
      expect([...seen(5_000)].sort()).toEqual(["elite", "elite_b", "elite_c"]);
    });

    it("без таймлайна в мире элит для волны нет: разлом не открывается", () => {
      const world = createWorld({
        seed: 1,
        enemies: [GRUNT, ELITE],
        weapons: WEAPONS,
        passives: PASSIVES,
        levelCurve: LEVEL_CURVE,
        loadoutLimits: LOADOUT_LIMITS,
        chests: CHESTS,
        secrets: ONLY_RIFT,
      });
      open(world);
      expect(eliteSlots(world)).toEqual([]);
      expect(rift(world).opened).toBe(false);
      expect(rift(world).used).toBe(false);
    });

    it("мир без элит в контенте не падает: разлом не открывается, сундука нет", () => {
      const world = createWorld({
        seed: 1,
        enemies: [GRUNT],
        weapons: WEAPONS,
        passives: PASSIVES,
        levelCurve: LEVEL_CURVE,
        loadoutLimits: LOADOUT_LIMITS,
        chests: CHESTS,
        secrets: ONLY_RIFT,
        timeline: TIMELINE,
        endlessCurve: CURVE,
      });
      const site = rift(world);
      standAt(world, site.x, site.y);
      expect(() => run(world, 5)).not.toThrow();
      expect(world.stats.enemiesSpawned).toBe(0);
      expect(site.opened).toBe(false);
      expect(site.used).toBe(false);
      expect(world.chests.openings).toHaveLength(0);
    });
  });

  describe("волна не поместилась в пул врагов", () => {
    it("вышло 0 элит — разлом не открывается: ни opened, ни used, ни события; следующий вход пробует снова", () => {
      const world = setup(ONLY_RIFT, 1, 4);
      const site = rift(world);
      const filler = [0, 1, 2, 3].map((k) => spawnEnemy(world, 0, 5_000 + 10 * k, 5_000));
      expect(filler.every((slot) => slot >= 0)).toBe(true);
      const streamBefore = world.secrets.rng.getState();

      open(world);
      expect(eliteSlots(world)).toEqual([]);
      expect(site.opened).toBe(false);
      expect(site.used).toBe(false);
      expect(used(world)).toEqual([]);
      // Неудачная попытка поток тайников не тратит.
      expect(world.secrets.rng.getState()).toBe(streamBefore);

      // Место освободилось, игрок вышел из круга и вошёл снова — разлом открывается.
      for (const slot of filler) despawnEnemy(world, slot);
      standAt(world, site.x + 10 * ONLY_RIFT.rift.radius, site.y);
      run(world, 2);
      standAt(world, site.x, site.y);
      run(world, 2);
      expect(site.opened).toBe(true);
      expect(eliteSlots(world).length).toBeGreaterThan(0);
    });

    it("вышло меньше положенного — волна из вышедших, сундук за них всех", () => {
      const world = setup(ONLY_RIFT, 1, 3);
      open(world);
      const slots = eliteSlots(world);
      expect(slots).toHaveLength(3);
      expect(rift(world).opened).toBe(true);

      for (const slot of slots) kill(world, slot);
      run(world, 2);
      expect(used(world)).toEqual([["rift", "cleared"]]);
      expect(world.chests.openings.map((opening) => opening.size)).toEqual([ONLY_RIFT.rift.chestSize]);
    });
  });

  describe("снимок прерванного забега", () => {
    it("посреди волны: восстановление → добил → сундук", () => {
      const world = setup(ONLY_RIFT);
      open(world);
      const slots = eliteSlots(world);
      for (const slot of slots.slice(0, 4)) kill(world, slot);
      run(world, 2);

      const next = restored(world);
      expect(rift(next).opened).toBe(true);
      expect(rift(next).wave).toHaveLength(WAVE - 4);
      expect(next.chests.openings).toHaveLength(0);

      run(next, 5);
      expect(next.chests.openings).toHaveLength(0);
      for (const slot of eliteSlots(next)) kill(next, slot);
      run(next, 2);
      expect(next.chests.openings.map((opening) => opening.size)).toEqual([ONLY_RIFT.rift.chestSize]);
      expect(used(next)).toEqual([["rift", "cleared"]]);
    });

    it("посреди волны: восстановление → срок вышел → left, срок не начинается заново", () => {
      const world = setup(ONLY_RIFT);
      open(world);
      run(world, LIMIT_TICKS - 600);

      const next = restored(world);
      expect(rift(next).waveTicks).toBe(rift(world).waveTicks);
      run(next, 500);
      expect(rift(next).used).toBe(false);
      run(next, 200);
      expect(rift(next).used).toBe(true);
      expect(used(next)).toEqual([["rift", "left"]]);
      expect(next.chests.openings).toHaveLength(0);
    });

    it("неоткрытый и закрытый разломы восстанавливаются как были", () => {
      const fresh = setup(ONLY_RIFT);
      const copy = restored(fresh);
      expect(rift(copy).opened).toBe(false);
      expect(rift(copy).wave).toEqual([]);

      open(fresh);
      for (const slot of eliteSlots(fresh)) kill(fresh, slot);
      run(fresh, 2);
      const closed = restored(fresh);
      expect(rift(closed).used).toBe(true);
      expect(rift(closed).opened).toBe(true);
      run(closed, 10);
      expect(closed.chests.openings).toHaveLength(0);
    });

    it("битая волна в снимке — SnapshotError", () => {
      const world = setup(ONLY_RIFT);
      open(world);
      const saved = JSON.parse(JSON.stringify(captureWorld(world, IDLE_SPAWNER)));
      const riftIndex = world.secrets.sites.findIndex((site) => site.kind === "rift");
      saved.secrets.sites[riftIndex].wave = "много";
      expect(() => restoreWorld(setup(ONLY_RIFT), IDLE_SPAWNER, saved)).toThrow(SnapshotError);
    });

    it("отсчёт щита древа переживает снимок: щит приходит в срок, а не заново", () => {
      const world = setup(ONLY_TREE);
      const tree = siteOf(world, "tree");
      standAt(world, tree.x, tree.y);
      const period = ONLY_TREE.tree.shieldEverySec * TICKS_PER_SEC;
      run(world, period - 30);
      expect(world.player.shieldHits).toBe(0);

      const next = setup(ONLY_TREE);
      restoreWorld(next, IDLE_SPAWNER, JSON.parse(JSON.stringify(captureWorld(world, IDLE_SPAWNER))));
      run(next, 20);
      expect(next.player.shieldHits).toBe(0);
      run(next, 20);
      expect(next.player.shieldHits).toBe(1);
    });
  });

  describe("второй шанс", () => {
    function die(world: World): void {
      world.player.hp = 0;
      world.player.alive = false;
    }

    it("открытый разлом при продолжении закрывается исходом left, сундука нет", () => {
      const world = setup(ONLY_RIFT);
      open(world);
      expect(eliteSlots(world)).toHaveLength(WAVE);

      die(world);
      expect(applyContinue(world)).toBe(true);
      expect(eliteSlots(world)).toEqual([]);
      run(world, 5);
      expect(rift(world).used).toBe(true);
      expect(rift(world).wave).toEqual([]);
      expect(world.chests.openings).toHaveLength(0);
      expect(used(world)).toEqual([["rift", "left"]]);
    });

    it("неоткрытый и уже закрытый разломы продолжение не трогает", () => {
      const fresh = setup(ONLY_RIFT);
      die(fresh);
      applyContinue(fresh);
      expect(rift(fresh).used).toBe(false);
      expect(used(fresh)).toEqual([]);

      const cleared = setup(ONLY_RIFT);
      open(cleared);
      for (const slot of eliteSlots(cleared)) kill(cleared, slot);
      run(cleared, 2);
      die(cleared);
      applyContinue(cleared);
      expect(used(cleared)).toEqual([["rift", "cleared"]]);
      expect(cleared.chests.openings).toHaveLength(1);
    });
  });
});

describe("правила и контент древа и разлома", () => {
  it("боевой контент проходит проверку; веса: древо во 2-м и 3-м кольцах, разлом только в 3-м", () => {
    expect(findSecretsProblems(SECRETS)).toEqual([]);
    const kindsOf = (ring: number): string[] => SECRETS.rings[ring].kinds.map((entry) => entry.kind);
    expect(kindsOf(0)).toEqual(["shrine"]);
    expect(kindsOf(1)).toContain("tree");
    expect(kindsOf(1)).not.toContain("rift");
    expect(kindsOf(2)).toContain("tree");
    expect(kindsOf(2)).toContain("rift");
    for (const ring of [1, 2]) {
      for (const entry of SECRETS.rings[ring].kinds) {
        if (entry.kind === "tree" || entry.kind === "rift") expect(entry.weight).toBe(1);
      }
    }
  });

  it("числа из решения: радиус 120, лечение 2 % в секунду, щит раз в 60 с; разлом: радиус 50, шесть элит кольцом 300, сундук 5, срок 90 с", () => {
    expect(SECRETS.tree).toEqual({ radius: 120, healPerSec: 0.02, shieldEverySec: 60 });
    expect(SECRETS.rift).toEqual({ radius: 50, elites: 6, ringRadius: 300, chestSize: 5, timeLimitSec: 90 });
  });

  it("ловит битые числа с путём до поля", () => {
    const broken = { ...SECRETS, tree: { ...SECRETS.tree, radius: 0, healPerSec: 2, shieldEverySec: 0 }, rift: { ...SECRETS.rift, elites: 0, ringRadius: -1, chestSize: 2 as 5, timeLimitSec: 0 } };
    const text = findSecretsProblems(broken).join("\n");
    for (const field of ["tree.radius", "tree.healPerSec", "tree.shieldEverySec", "rift.elites", "rift.ringRadius", "rift.chestSize", "rift.timeLimitSec"]) {
      expect(text, field).toContain(`secrets.${field}`);
    }
  });

  it("схема снимка контента знает древо и разлом: принимает боевые числа, требует срок", () => {
    const viaJson = (secrets: unknown): unknown => JSON.parse(JSON.stringify({ ...CONTENT_SNAPSHOT, secrets }));
    expect(contentSnapshotSchema.safeParse(viaJson(SECRETS)).success).toBe(true);
    const { timeLimitSec: _limit, ...riftWithoutLimit } = SECRETS.rift;
    void _limit;
    const parsed = contentSnapshotSchema.safeParse(viaJson({ ...SECRETS, rift: riftWithoutLimit }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("secrets.rift.timeLimitSec");
  });

  it("срок разлома: коридор 20…300 секунд, границы входят", () => {
    const withLimit = (timeLimitSec: number): string => findSecretsProblems({ ...SECRETS, rift: { ...SECRETS.rift, timeLimitSec } }).join("\n");
    for (const ok of [20, 90, 300]) expect(withLimit(ok), String(ok)).toBe("");
    for (const bad of [19.9, 300.1, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(withLimit(bad), String(bad)).toContain("secrets.rift.timeLimitSec");
    }
  });

  it("раскладка из ring-весов бросает и древо, и разлом; число мест прежнее", () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const world = setup(SECRETS, seed);
      expect(world.secrets.sites).toHaveLength(SECRETS.rings.reduce((total, ring) => total + ring.count, 0) + 1);
      for (const site of world.secrets.sites) kinds.add(site.kind);
    }
    expect(kinds.has("tree")).toBe(true);
    expect(kinds.has("rift")).toBe(true);
  });

  it("огонёк ведёт и к древу, и к разлому: они неоткрытые тайники", () => {
    const world = setup(rules({ rings: [{ ...RING, count: 1, kinds: [{ kind: "tree", weight: 1 }] }] }));
    const wisp = world.secrets.sites.find((site) => site.kind === "wisp");
    expect(wisp).toBeDefined();
    run(world, (SECRETS.wisp.appearSec + 1) * TICKS_PER_SEC);
    const tree = siteOf(world, "tree");
    const before = Math.hypot((wisp?.x ?? 0) - tree.x, (wisp?.y ?? 0) - tree.y);
    run(world, 5 * TICKS_PER_SEC);
    const after = Math.hypot((wisp?.x ?? 0) - tree.x, (wisp?.y ?? 0) - tree.y);
    expect(after).toBeLessThan(before);
  });
});
