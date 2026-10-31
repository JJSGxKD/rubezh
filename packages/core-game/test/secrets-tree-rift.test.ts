import type { EnemyDef, SecretsDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { SECRETS } from "../src/content/secrets";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { damageEnemy } from "../src/game/sim/combat";
import { findSecretsProblems, secretKindsFound, secretKindsUsed, takeSecretEvents } from "../src/game/sim/secrets";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, NO_OWNER_TYPE, type SecretSite, type World } from "../src/game/sim/world";

// Древо-оберег и разлом Нави (docs/35-stage4-plan.md, Р153; tasks/T-0259):
// два тайника дальних колец с выбором «рискнуть или нет». Древо лечит и раз в
// минуту даёт щит, пока игрок рядом; разлом выпускает волну элит и отдаёт
// большой сундук за победу. Случайность — только из потока тайников.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
/** Элита почти неподвижна: она стоит там, где вышла, и не бьёт игрока. */
const ELITE: EnemyDef = { id: "elite", hp: 100, speed: 0.001, damage: 0, xp: 5, pattern: "swarm", rank: "elite" };

const RING = { minRadius: 700, maxRadius: 1_100 };
const TICKS_PER_SEC = 60;

function rules(patch: Partial<SecretsDef>): SecretsDef {
  return { ...SECRETS, ...patch };
}

const ONLY_TREE = rules({ rings: [{ ...RING, count: 1, kinds: [{ kind: "tree", weight: 1 }] }] });
const ONLY_RIFT = rules({ rings: [{ ...RING, count: 1, kinds: [{ kind: "rift", weight: 1 }] }] });

function setup(secrets: SecretsDef, seed = 1): World {
  return createWorld({
    seed,
    enemies: [GRUNT, ELITE],
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: CHESTS,
    secrets,
  });
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
    if (world.enemies.alive[i] === 1 && world.enemyTypes[world.enemies.type[i]].id === "elite") slots.push(i);
  }
  return slots;
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
  const rift = (world: World): SecretSite => siteOf(world, "rift");

  function open(world: World): void {
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
    expect(secretKindsFound(world)).toEqual(["rift"]);
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
    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.used.map((event) => [event.kind, event.outcome])).toEqual([["rift", "cleared"]]);
  });

  it("ушёл, не добив, — сундука нет, исход left; добитая позже волна ничего не даёт", () => {
    const world = setup(ONLY_RIFT);
    open(world);
    const site = rift(world);
    const slots = eliteSlots(world);
    kill(world, slots[0]);

    standAt(world, site.x + 3 * ONLY_RIFT.rift.ringRadius * world.config.unitScale, site.y);
    run(world, 2);
    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.used.map((event) => [event.kind, event.outcome])).toEqual([["rift", "left"]]);
    expect(site.used).toBe(true);

    for (const slot of slots.slice(1)) kill(world, slot);
    run(world, 2);
    expect(world.chests.openings).toHaveLength(0);
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
      standAt(world, site.x, site.y);
      stepWorld(world, IDLE_INPUT);
    }
    expect(eliteSlots(withRift)).toHaveLength(WAVE);
    expect(withRift.rng.getState()).toBe(without.rng.getState());
  });

  it("мир без элит в контенте не падает: волна пуста, разлом закрывается без сундука", () => {
    const world = createWorld({
      seed: 1,
      enemies: [GRUNT],
      weapons: WEAPONS,
      passives: PASSIVES,
      levelCurve: LEVEL_CURVE,
      loadoutLimits: LOADOUT_LIMITS,
      chests: CHESTS,
      secrets: ONLY_RIFT,
    });
    const site = rift(world);
    standAt(world, site.x, site.y);
    expect(() => run(world, 5)).not.toThrow();
    expect(world.stats.enemiesSpawned).toBe(0);
    expect(world.chests.openings).toHaveLength(0);
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

  it("числа из решения: радиус 120, лечение 2 % в секунду, щит раз в 60 с; разлом: радиус 50, шесть элит кольцом 300, сундук 5", () => {
    expect(SECRETS.tree).toEqual({ radius: 120, healPerSec: 0.02, shieldEverySec: 60 });
    expect(SECRETS.rift).toEqual({ radius: 50, elites: 6, ringRadius: 300, chestSize: 5 });
  });

  it("ловит битые числа с путём до поля", () => {
    const broken = { ...SECRETS, tree: { ...SECRETS.tree, radius: 0, healPerSec: 2, shieldEverySec: 0 }, rift: { ...SECRETS.rift, elites: 0, ringRadius: -1, chestSize: 2 as 5 } };
    const text = findSecretsProblems(broken).join("\n");
    for (const field of ["tree.radius", "tree.healPerSec", "tree.shieldEverySec", "rift.elites", "rift.ringRadius", "rift.chestSize"]) {
      expect(text, field).toContain(`secrets.${field}`);
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
