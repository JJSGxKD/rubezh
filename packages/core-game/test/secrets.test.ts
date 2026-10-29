import type { EnemyDef, MapDef, SecretsDef } from "@bh/shared-types";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { MAPS } from "../src/content/maps";
import { SECRETS } from "../src/content/secrets";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { refreshPlayerStats } from "../src/game/progression/levels";
import { LOADOUT_BOUNDS } from "../src/game/progression/run-loadout";
import { buildRunResult } from "../src/game/run/run-result";
import { createRng, deriveSeed, STREAM_SALT } from "../src/game/sim/rng";
import {
  chooseBlessing,
  isAwaitingBlessing,
  secretKindsFound,
  secretKindsUsed,
  takeSecretEvents,
} from "../src/game/sim/secrets";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, damagePlayer, type CreateWorldOptions, type SecretSite, type World } from "../src/game/sim/world";

// Тайники рубежа (docs/35-stage4-plan.md, Р153): места на карте, ради которых
// стоит идти. Позиции, виды и выбор благословений — из собственного потока
// случайности; `world.rng` тайники не трогают ни разу.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };

const RING_ONE = { minRadius: 700, maxRadius: 1_100 };
const RING_TWO = { minRadius: 1_600, maxRadius: 2_400 };

function rules(patch: Partial<SecretsDef>): SecretsDef {
  return { ...SECRETS, ...patch };
}

/** Одно капище в первом кольце; благословений ровно три, чтобы «Ярость» была в каждом выборе. */
const ONLY_SHRINE = rules({
  rings: [{ ...RING_ONE, count: 1, kinds: [{ kind: "shrine", weight: 1 }] }],
  blessings: SECRETS.blessings.slice(0, 3),
});
const ONLY_HOARD = rules({ rings: [{ ...RING_ONE, count: 1, kinds: [{ kind: "hoard", weight: 1 }] }] });
const STONE_AND_HOARDS = rules({
  rings: [
    { ...RING_ONE, count: 1, kinds: [{ kind: "stone", weight: 1 }] },
    { ...RING_TWO, count: 2, kinds: [{ kind: "hoard", weight: 1 }] },
  ],
});
/** Капище и клад: огонёк (он один на забег) должен выбирать из двух неоткрытых ближайший. */
const WISP_RULES = rules({
  rings: [
    { ...RING_ONE, count: 1, kinds: [{ kind: "shrine", weight: 1 }] },
    { ...RING_TWO, count: 1, kinds: [{ kind: "hoard", weight: 1 }] },
  ],
});

function setup(secrets: SecretsDef = SECRETS, seed = 1, patch: Partial<CreateWorldOptions> = {}): World {
  return createWorld({
    seed,
    enemies: [GRUNT],
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    chests: CHESTS,
    secrets,
    ...patch,
  });
}

/** Поставить игрока ровно в точку; скорость нулевая, шаг его не сдвинет. */
function standAt(world: World, x: number, y: number): void {
  const player = world.player;
  player.x = x;
  player.y = y;
  player.prevX = x;
  player.prevY = y;
  player.vx = 0;
  player.vy = 0;
}

function standOn(world: World, site: SecretSite, offset = 0): void {
  standAt(world, site.x + offset, site.y);
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

function distanceFromStart(site: SecretSite): number {
  return Math.sqrt(site.x * site.x + site.y * site.y);
}

function layoutOf(world: World): [string, number, number][] {
  return world.secrets.sites.map((site) => [site.kind, site.x, site.y]);
}

const TICKS_PER_SEC = 60;

function wispOf(world: World): SecretSite {
  const wisp = world.secrets.sites.find((site) => site.kind === "wisp");
  if (wisp === undefined) throw new Error("в раскладке нет огонька");
  return wisp;
}

describe("поток случайности тайников", () => {
  it("соль потока не совпадает с сундуками и карточками", () => {
    expect(STREAM_SALT.secret).not.toBe(STREAM_SALT.chest);
    expect(STREAM_SALT.secret).not.toBe(STREAM_SALT.cards);
    expect(deriveSeed(7, STREAM_SALT.secret)).not.toBe(deriveSeed(7, STREAM_SALT.chest));
    expect(deriveSeed(7, STREAM_SALT.secret)).not.toBe(deriveSeed(8, STREAM_SALT.secret));
  });

  it("мир без колец не тратит поток тайников", () => {
    const world = setup(rules({ rings: [] }), 5);
    expect(world.secrets.sites).toHaveLength(0);
    expect(world.secrets.rng.getState()).toBe(createRng(deriveSeed(5, STREAM_SALT.secret)).getState());
  });

  it("в файлах тайников нет обращений к world.rng — только к собственному потоку", () => {
    const read = (name: string): string =>
      readFileSync(fileURLToPath(new URL(`../src/game/sim/${name}`, import.meta.url)), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/.*/g, " ");
    for (const name of ["secrets.ts", "secrets-layout.ts", "secrets-rules.ts"]) {
      expect(read(name), name).not.toMatch(/world\.rng/);
    }
    expect(read("secrets.ts")).toMatch(/world\.secrets\.rng/);
  });

  it("весь путь капища не сдвигает world.rng", () => {
    const world = setup(ONLY_SHRINE, 3);
    const before = world.rng.getState();
    standOn(world, world.secrets.sites[0]);
    run(world, 3 * TICKS_PER_SEC + 5);
    expect(world.secrets.blessings).toHaveLength(1);
    expect(world.rng.getState()).toBe(before);
  });
});

describe("размещение по кольцам", () => {
  it("один seed — одни позиции и виды, другой seed — другие", () => {
    expect(layoutOf(setup(SECRETS, 11))).toEqual(layoutOf(setup(SECRETS, 11)));
    const layouts = new Set([1, 2, 3, 4, 5].map((seed) => JSON.stringify(layoutOf(setup(SECRETS, seed)))));
    expect(layouts.size).toBeGreaterThan(1);
  });

  it("мест на карте всегда пять — 1, 2 и 2 по кольцам, на любом seed", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const places = setup(SECRETS, seed).secrets.sites.filter((site) => site.kind !== "wisp");
      expect(places.map((site) => site.ring), `seed ${seed}`).toEqual([0, 1, 1, 2, 2]);
    }
  });

  it("огонёк один на забег, последний в списке и без кольца", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const sites = setup(SECRETS, seed).secrets.sites;
      const wisps = sites.filter((site) => site.kind === "wisp");
      expect(wisps, `seed ${seed}`).toHaveLength(1);
      expect(sites.at(-1)).toBe(wisps[0]);
      expect(wisps[0].ring).toBe(-1);
      expect(wisps[0].active).toBe(false);
    }
  });

  it("без колец нет и огонька", () => {
    expect(setup(rules({ rings: [] }), 3).secrets.sites).toHaveLength(0);
  });

  it("в дальних кольцах клад, камень, древо и разлом (разлом — только в третьем), все встречаются", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      for (const site of setup(SECRETS, seed).secrets.sites) {
        if (site.ring < 1) continue;
        expect(["hoard", "stone", "tree", "rift"], `seed ${seed}`).toContain(site.kind);
        // Кольца считаются с нуля: второе — 1, третье — 2.
        if (site.kind === "rift") expect(site.ring, `seed ${seed}`).toBe(2);
        seen.add(site.kind);
      }
    }
    expect([...seen].sort()).toEqual(["hoard", "rift", "stone", "tree"]);
  });

  it("первое кольцо — капище на 700–1100 единиц от старта, на любом масштабе", () => {
    for (const unitScale of [1, 2]) {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const first = setup(SECRETS, seed, { config: { unitScale } }).secrets.sites[0];
        expect(first.kind).toBe("shrine");
        const distance = distanceFromStart(first) / unitScale;
        expect(distance).toBeGreaterThanOrEqual(700 - 1e-6);
        expect(distance).toBeLessThanOrEqual(1_100 + 1e-6);
      }
    }
  });

  it("остальные места лежат в своих кольцах, а виды — из весов кольца", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const sites = setup(SECRETS, seed).secrets.sites;
      sites.forEach((site) => {
        // У огонька ни кольца, ни места: он появится у игрока.
        if (site.kind === "wisp") return;
        const ring = SECRETS.rings[site.ring];
        expect(ring.kinds.map((entry) => entry.kind)).toContain(site.kind);
        const distance = distanceFromStart(site);
        expect(distance).toBeGreaterThanOrEqual(ring.minRadius - 1e-6);
        expect(distance).toBeLessThanOrEqual(ring.maxRadius + 1e-6);
      });
    }
  });

  it("тайники на земле не лежат друг на друге", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const placed = setup(SECRETS, seed).secrets.sites.filter((site) => site.kind !== "wisp");
      for (let a = 0; a < placed.length; a++) {
        for (let b = a + 1; b < placed.length; b++) {
          const dx = placed[a].x - placed[b].x;
          const dy = placed[a].y - placed[b].y;
          expect(Math.sqrt(dx * dx + dy * dy), `seed ${seed}: ${a}–${b}`).toBeGreaterThanOrEqual(SECRETS.minGapUnits);
        }
      }
    }
  });

  it("на карте с границей тайники не выходят за неё", () => {
    const corridor: MapDef = { ...MAPS[0], id: "corridor-fixture", bounds: { halfWidth: 1_800 } };
    for (let seed = 1; seed <= 10; seed++) {
      const world = setup(SECRETS, seed, { map: corridor });
      for (const site of world.secrets.sites) expect(Math.abs(site.x)).toBeLessThanOrEqual(1_800);
    }
  });

  it("поначалу ничего не найдено, не открыто и не видно на радаре", () => {
    const world = setup(SECRETS, 2);
    for (const site of world.secrets.sites) {
      expect(site.found).toBe(false);
      expect(site.used).toBe(false);
      expect(site.visible).toBe(false);
      expect(site.holdTicks).toBe(0);
    }
  });

  it("битые данные мир не принимает", () => {
    const broken = rules({ shrine: { ...SECRETS.shrine, radius: 0 } });
    expect(() => setup(broken)).toThrow(/Некорректный контент тайников[\s\S]*secrets\.shrine\.radius/);
  });
});

describe("капище", () => {
  function shrineWorld(seed = 1): { world: World; site: SecretSite } {
    const world = setup(ONLY_SHRINE, seed);
    world.secrets.manualBlessing = true;
    return { world, site: world.secrets.sites[0] };
  }

  it("три секунды в круге — выбор из трёх разных благословений, мир стоит", () => {
    const { world, site } = shrineWorld();
    standOn(world, site, SECRETS.shrine.radius - 1);

    run(world, 3 * TICKS_PER_SEC - 1);
    expect(isAwaitingBlessing(world)).toBe(false);
    run(world, 1);
    expect(isAwaitingBlessing(world)).toBe(true);

    const options = world.secrets.offer?.options ?? [];
    expect(options).toHaveLength(3);
    expect(new Set(options).size).toBe(3);
    for (const id of options) expect(ONLY_SHRINE.blessings.map((blessing) => blessing.id)).toContain(id);

    const tick = world.stats.tick;
    run(world, 30);
    expect(world.stats.tick).toBe(tick);
  });

  it("событие несёт полные описания благословений для окна выбора", () => {
    const { world, site } = shrineWorld();
    standOn(world, site);
    run(world, 3 * TICKS_PER_SEC);

    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.blessings).toHaveLength(1);
    expect(events.blessings[0].options).toHaveLength(3);
    for (const option of events.blessings[0].options) {
      expect(option.nameKey).toBe(`blessing.${option.id}`);
      expect(Object.keys(option.modifiers).length).toBeGreaterThan(0);
    }
    expect(events.used).toHaveLength(0);
  });

  it("вышел из круга — прогресс с нуля, даже за полсекунды до конца", () => {
    const { world, site } = shrineWorld();
    standOn(world, site);
    run(world, Math.round(2.5 * TICKS_PER_SEC));
    expect(site.holdTicks).toBe(150);

    standOn(world, site, SECRETS.shrine.radius + 5);
    run(world, 1);
    expect(site.holdTicks).toBe(0);

    standOn(world, site);
    run(world, 3 * TICKS_PER_SEC - 1);
    expect(isAwaitingBlessing(world)).toBe(false);
    run(world, 1);
    expect(isAwaitingBlessing(world)).toBe(true);
  });

  it("урон прогресс не сбрасывает: риск в том, что стоишь в толпе", () => {
    const { world, site } = shrineWorld();
    standOn(world, site);
    run(world, 100);
    const before = world.player.hp;
    damagePlayer(world, 5, -1);
    expect(world.player.hp).toBeLessThan(before);
    expect(site.holdTicks).toBe(100);

    run(world, 80);
    expect(isAwaitingBlessing(world)).toBe(true);
  });

  it("круг считается по радиусу в единицах: на масштабе 2 он вдвое шире в пикселях", () => {
    const world = setup(ONLY_SHRINE, 1, { config: { unitScale: 2 } });
    const site = world.secrets.sites[0];
    standOn(world, site, SECRETS.shrine.radius * 2 - 1);
    run(world, 1);
    expect(site.holdTicks).toBe(1);
    standOn(world, site, SECRETS.shrine.radius * 2 + 1);
    run(world, 1);
    expect(site.holdTicks).toBe(0);
  });

  it("мёртвый игрок прогресс не копит", () => {
    const { world, site } = shrineWorld();
    standOn(world, site);
    world.player.alive = false;
    run(world, 10);
    expect(site.holdTicks).toBe(0);
  });

  it("выбор «Ярость» — урон игрока ×1,1, мир идёт дальше, тайник израсходован", () => {
    const { world, site } = shrineWorld();
    standOn(world, site);
    run(world, 3 * TICKS_PER_SEC);
    expect(world.playerStats.damageMul).toBeCloseTo(1, 9);

    expect(chooseBlessing(world, "fury")).toBe(true);
    expect(world.playerStats.damageMul).toBeCloseTo(1.1, 9);
    expect(world.secrets.blessings).toEqual(["fury"]);
    expect(isAwaitingBlessing(world)).toBe(false);
    expect(site.used).toBe(true);

    const tick = world.stats.tick;
    run(world, 5);
    expect(world.stats.tick).toBe(tick + 5);
  });

  it("со снаряжением прибавка упирается в LOADOUT_BOUNDS", () => {
    const loadout = { modifiers: { damage: LOADOUT_BOUNDS.damage - 0.05 }, boosts: [] };
    const world = setup(ONLY_SHRINE, 1, { loadout });
    world.secrets.manualBlessing = true;
    standOn(world, world.secrets.sites[0]);
    run(world, 3 * TICKS_PER_SEC);

    expect(chooseBlessing(world, "fury")).toBe(true);
    expect(world.loadoutModifiers.damage).toBe(LOADOUT_BOUNDS.damage);
    expect(world.playerStats.damageMul).toBeCloseTo(1 + LOADOUT_BOUNDS.damage, 9);
  });

  it("благословение переживает пересчёт характеристик на уровне", () => {
    const { world, site } = shrineWorld();
    standOn(world, site);
    run(world, 3 * TICKS_PER_SEC);
    chooseBlessing(world, "fury");

    // Любое улучшение пересчитывает характеристики целиком из набора на забег.
    refreshPlayerStats(world);
    expect(world.playerStats.damageMul).toBeCloseTo(1.1, 9);
  });

  it("выбор «Зоркости» — перезарядка оружия на 8 % короче", () => {
    const keenRules = rules({
      rings: ONLY_SHRINE.rings,
      blessings: ["keen", "wind", "harvest"].map((id) => SECRETS.blessings.find((blessing) => blessing.id === id)!),
    });
    const world = setup(keenRules, 1);
    world.secrets.manualBlessing = true;
    standOn(world, world.secrets.sites[0]);
    run(world, 3 * TICKS_PER_SEC);
    expect(world.playerStats.cooldownMul).toBeCloseTo(1, 9);

    expect(chooseBlessing(world, "keen")).toBe(true);
    expect(world.playerStats.cooldownMul).toBeCloseTo(0.92, 9);
  });

  it("чужой выбор не принимается: неизвестный id, вне предложенных, без предложения", () => {
    const { world, site } = shrineWorld();
    expect(chooseBlessing(world, "fury")).toBe(false);

    standOn(world, site);
    run(world, 3 * TICKS_PER_SEC);
    expect(chooseBlessing(world, "no_such_blessing")).toBe(false);
    expect(chooseBlessing(world, "flame")).toBe(false);
    expect(isAwaitingBlessing(world)).toBe(true);

    expect(chooseBlessing(world, "wind")).toBe(true);
    expect(chooseBlessing(world, "wind")).toBe(false);
    expect(world.secrets.blessings).toEqual(["wind"]);
  });

  it("выбор отзывается событием «использован» с id благословения", () => {
    const { world, site } = shrineWorld();
    standOn(world, site);
    run(world, 3 * TICKS_PER_SEC);
    chooseBlessing(world, "harvest");

    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.used).toHaveLength(1);
    expect(events.used[0]).toMatchObject({ index: 0, kind: "shrine", outcome: "harvest" });
    expect(events.used[0].elapsedSec).toBeCloseTo(3, 9);
  });

  it("без пауз выбора (боты, golden) берётся первый из трёх, а набор тот же", () => {
    const manual = shrineWorld(9).world;
    const bot = setup(ONLY_SHRINE, 9);
    for (const world of [manual, bot]) {
      standOn(world, world.secrets.sites[0]);
      run(world, 3 * TICKS_PER_SEC);
    }
    const options = manual.secrets.offer?.options ?? [];
    expect(options).toHaveLength(3);
    expect(bot.secrets.offer).toBeNull();
    expect(bot.secrets.blessings).toEqual([options[0]]);
    expect(bot.secrets.rng.getState()).toBe(manual.secrets.rng.getState());
  });

  it("повторно капище не срабатывает", () => {
    const world = setup(ONLY_SHRINE, 1);
    const site = world.secrets.sites[0];
    standOn(world, site);
    run(world, 3 * TICKS_PER_SEC);
    run(world, 5 * TICKS_PER_SEC);
    expect(world.secrets.blessings).toHaveLength(1);
  });
});

describe("клад", () => {
  it("две секунды на месте — сундук размера 3 через сундуки", () => {
    const world = setup(ONLY_HOARD, 1);
    const site = world.secrets.sites[0];
    standOn(world, site, SECRETS.hoard.radius - 1);

    run(world, 2 * TICKS_PER_SEC - 1);
    expect(world.chests.openings).toHaveLength(0);
    run(world, 1);

    expect(world.chests.openings).toHaveLength(1);
    expect(world.chests.openings[0].size).toBe(3);
    expect(world.chests.openings[0].rewards).toHaveLength(3);
    expect(world.stats.chestsOpened).toBe(1);
    expect(site.used).toBe(true);
  });

  it("шаг в сторону сбрасывает счёт, а повторно клад не выкапывается", () => {
    const world = setup(ONLY_HOARD, 1);
    const site = world.secrets.sites[0];
    standOn(world, site);
    run(world, 100);
    standOn(world, site, SECRETS.hoard.radius + 1);
    run(world, 1);
    expect(site.holdTicks).toBe(0);

    standOn(world, site);
    run(world, 5 * TICKS_PER_SEC);
    expect(world.chests.openings).toHaveLength(1);
  });

  it("событие «использован» называет исход", () => {
    const world = setup(ONLY_HOARD, 1);
    standOn(world, world.secrets.sites[0]);
    run(world, 2 * TICKS_PER_SEC);
    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.used.map((entry) => [entry.kind, entry.outcome])).toEqual([["hoard", "opened"]]);
  });
});

describe("камень-указатель", () => {
  it("касание открывает все тайники на радаре", () => {
    const world = setup(STONE_AND_HOARDS, 2);
    const [stone, ...others] = world.secrets.sites;
    expect(others.every((site) => !site.visible)).toBe(true);

    standOn(world, stone, SECRETS.stone.radius - 1);
    run(world, 1);

    const places = world.secrets.sites.filter((site) => site.kind !== "wisp");
    expect(places.every((site) => site.visible)).toBe(true);
    // Огонька до 90-й секунды на карте нет, показывать на радаре нечего.
    expect(wispOf(world).visible).toBe(false);
    expect(stone.used).toBe(true);
    expect(others.every((site) => !site.found)).toBe(true);
  });

  it("за радиусом камня ничего не происходит", () => {
    const world = setup(STONE_AND_HOARDS, 2);
    const stone = world.secrets.sites[0];
    standOn(world, stone, SECRETS.stone.radius + 1);
    run(world, 10);
    expect(stone.found).toBe(false);
    expect(world.secrets.sites.some((site) => site.visible)).toBe(false);
  });

  it("камень срабатывает один раз", () => {
    const world = setup(STONE_AND_HOARDS, 2);
    standOn(world, world.secrets.sites[0]);
    run(world, 30);
    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.used.filter((entry) => entry.kind === "stone")).toHaveLength(1);
    expect(events.found.filter((entry) => entry.kind === "stone")).toHaveLength(1);
  });
});

describe("найденный тайник", () => {
  it("тайник найден, когда игрок вошёл в его круг, и виден на радаре", () => {
    const world = setup(ONLY_HOARD, 1);
    const site = world.secrets.sites[0];
    standOn(world, site, SECRETS.hoard.radius + 1);
    run(world, 1);
    expect(site.found).toBe(false);
    expect(site.visible).toBe(false);

    standOn(world, site, SECRETS.hoard.radius - 1);
    run(world, 1);
    expect(site.found).toBe(true);
    expect(site.visible).toBe(true);

    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.found).toHaveLength(1);
    expect(events.found[0]).toMatchObject({ index: 0, kind: "hoard" });
  });

  it("курсор отдаёт каждую запись один раз", () => {
    const world = setup(ONLY_HOARD, 1);
    standOn(world, world.secrets.sites[0]);
    run(world, 2 * TICKS_PER_SEC);

    const first = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(first.found).toHaveLength(1);
    expect(first.used).toHaveLength(1);
    const second = takeSecretEvents(world, first.cursor);
    expect(second.found).toHaveLength(0);
    expect(second.used).toHaveLength(0);
    expect(second.cursor).toEqual(first.cursor);
  });
});

describe("огонёк", () => {
  const APPEAR_TICKS = 90 * TICKS_PER_SEC;

  function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  it("до 90-й секунды его нет на карте, на 90-й — у игрока и сразу виден", () => {
    const world = setup(WISP_RULES, 1);
    const wisp = wispOf(world);
    run(world, APPEAR_TICKS - 1);
    expect(wisp.active).toBe(false);
    expect(wisp.visible).toBe(false);

    standAt(world, 12, -7);
    run(world, 1);
    expect(wisp.active).toBe(true);
    expect(wisp.visible).toBe(true);
    expect(wisp.found).toBe(true);
    expect([wisp.x, wisp.y]).toEqual([12, -7]);

    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.found.map((entry) => entry.kind)).toContain("wisp");
    expect(events.found.find((entry) => entry.kind === "wisp")?.elapsedSec).toBeCloseTo(90, 9);
  });

  it("летит к ближайшему неоткрытому тайнику со скоростью 80 единиц в секунду", () => {
    const world = setup(WISP_RULES, 1);
    const wisp = wispOf(world);
    const [shrine, hoard] = world.secrets.sites;
    standAt(world, 0, 0);
    run(world, APPEAR_TICKS);
    // Капище из первого кольца ближе клада из второго.
    expect(distanceBetween(wisp, shrine)).toBeLessThan(distanceBetween(wisp, hoard));

    const start = { x: wisp.x, y: wisp.y };
    const toShrine = distanceBetween(start, shrine);
    run(world, TICKS_PER_SEC);

    expect(distanceBetween(start, wisp)).toBeCloseTo(SECRETS.wisp.speed, 6);
    expect(wisp.x - start.x).toBeCloseTo(((shrine.x - start.x) / toShrine) * SECRETS.wisp.speed, 6);
    expect(wisp.y - start.y).toBeCloseTo(((shrine.y - start.y) / toShrine) * SECRETS.wisp.speed, 6);
  });

  it("долетает до края круга и ждёт игрока", () => {
    const world = setup(WISP_RULES, 1);
    const wisp = wispOf(world);
    const shrine = world.secrets.sites[0];
    standAt(world, 0, 0);
    run(world, APPEAR_TICKS);
    run(world, 20 * TICKS_PER_SEC);

    expect(distanceBetween(wisp, shrine)).toBeCloseTo(SECRETS.shrine.radius, 6);
    const waiting = { x: wisp.x, y: wisp.y };
    run(world, TICKS_PER_SEC);
    expect([wisp.x, wisp.y]).toEqual([waiting.x, waiting.y]);
  });

  it("нашёл игрок тайник — огонёк переключается на следующий неоткрытый", () => {
    const world = setup(WISP_RULES, 1);
    const wisp = wispOf(world);
    const [shrine, hoard] = world.secrets.sites;
    standAt(world, 0, 0);
    run(world, APPEAR_TICKS);

    // Игрок заходит в круг капища, огонёк это видит и идёт к кладу.
    standOn(world, shrine);
    run(world, 1);
    expect(shrine.found).toBe(true);
    const start = { x: wisp.x, y: wisp.y };
    standAt(world, 0, 0);
    run(world, TICKS_PER_SEC);

    const toHoard = distanceBetween(start, hoard);
    expect(wisp.x - start.x).toBeCloseTo(((hoard.x - start.x) / toHoard) * SECRETS.wisp.speed, 6);
    expect(wisp.y - start.y).toBeCloseTo(((hoard.y - start.y) / toHoard) * SECRETS.wisp.speed, 6);
  });

  it("все тайники найдены — огонёк стоит на месте", () => {
    const world = setup(WISP_RULES, 1);
    const wisp = wispOf(world);
    standAt(world, 0, 0);
    run(world, APPEAR_TICKS);
    for (const site of world.secrets.sites) site.found = true;
    const before = { x: wisp.x, y: wisp.y };
    run(world, 2 * TICKS_PER_SEC);
    expect([wisp.x, wisp.y]).toEqual([before.x, before.y]);
  });
});

describe("итог забега", () => {
  const OPTIONS = { runId: "r", seed: 1, outcome: "died" as const, startingWeaponId: "spark", contentHash: "00000000" };

  it("без тайников — пустые списки", () => {
    const world = setup(rules({ rings: [] }), 1);
    expect(buildRunResult(world, OPTIONS).secrets).toEqual({ found: [], used: [] });
  });

  it("несёт найденные и использованные виды без повторов", () => {
    const world = setup(STONE_AND_HOARDS, 2);
    const [stone, hoardA, hoardB] = world.secrets.sites;

    standOn(world, stone);
    run(world, 1);
    expect(secretKindsFound(world)).toEqual(["stone"]);
    expect(secretKindsUsed(world)).toEqual(["stone"]);

    // Заглянул в круг клада, но выкапывать не стал: найден, не использован.
    standOn(world, hoardA);
    run(world, 1);
    // Порядок видов — канонический (`SECRET_KINDS`), а не порядок находок: он не зависит от раскладки.
    expect(buildRunResult(world, OPTIONS).secrets).toEqual({ found: ["hoard", "stone"], used: ["stone"] });

    for (const hoard of [hoardA, hoardB]) {
      standOn(world, hoard);
      run(world, 2 * TICKS_PER_SEC);
    }
    expect(buildRunResult(world, OPTIONS).secrets).toEqual({ found: ["hoard", "stone"], used: ["hoard", "stone"] });
  });
});
