import type { EnemyDef, SecretsDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { SECRETS } from "../src/content/secrets";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { WEAPONS } from "../src/content/weapons";
import { buildRunResult } from "../src/game/run/run-result";
import { secretKindsFound, secretKindsUsed, takeSecretEvents } from "../src/game/sim/secrets";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { createWorld, type CreateWorldOptions, type SecretSite, type World } from "../src/game/sim/world";

// Огонёк (docs/35-stage4-plan.md, Р214): ведёт к тайнику шагами с отклонением то
// влево, то вправо, после каждого шага ждёт игрока; последний шаг — прямо к краю
// круга; когда вести некуда, гаснет.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };

const WISP = SECRETS.wisp;
const TICKS_PER_SEC = 60;
const APPEAR_TICKS = WISP.appearSec * TICKS_PER_SEC;
/** Расстояние, на котором игрок идёт за огоньком: ближе `waitUnits`, но не в круге тайника. */
const ESCORT_DISTANCE = 100;

const WISP_RULES: SecretsDef = {
  ...SECRETS,
  rings: [
    { minRadius: 700, maxRadius: 1_100, count: 1, kinds: [{ kind: "shrine", weight: 1 }] },
    { minRadius: 1_600, maxRadius: 2_400, count: 1, kinds: [{ kind: "hoard", weight: 1 }] },
  ],
};

interface Point {
  x: number;
  y: number;
}

function setup(secrets: SecretsDef = WISP_RULES, seed = 1, patch: Partial<CreateWorldOptions> = {}): World {
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

function standAt(world: World, x: number, y: number): void {
  const player = world.player;
  player.x = x;
  player.y = y;
  player.prevX = x;
  player.prevY = y;
  player.vx = 0;
  player.vy = 0;
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

function wispOf(world: World): SecretSite {
  const wisp = world.secrets.sites.find((site) => site.kind === "wisp");
  if (wisp === undefined) throw new Error("в раскладке нет огонька");
  return wisp;
}

function places(world: World): SecretSite[] {
  return world.secrets.sites.filter((site) => site.kind !== "wisp");
}

function distance(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

/** Мир ровно на 90-й секунде: игрок в начале координат, огонёк только что появился. */
function appeared(seed = 1, secrets: SecretsDef = WISP_RULES): World {
  const world = setup(secrets, seed);
  standAt(world, 0, 0);
  run(world, APPEAR_TICKS);
  return world;
}

/** Игрок стоит на `ESCORT_DISTANCE` позади огонька (от цели): рядом, но вне круга тайника. */
function escort(world: World, target: Point): void {
  const wisp = wispOf(world);
  const length = distance(wisp, target);
  const ux = (wisp.x - target.x) / length;
  const uy = (wisp.y - target.y) / length;
  standAt(world, wisp.x + ux * ESCORT_DISTANCE, wisp.y + uy * ESCORT_DISTANCE);
}

interface Hop {
  start: Point;
  end: Point;
  /** вектор от старта на цель в момент решения */
  toTarget: Point;
}

/** Идти за огоньком к `target`, пока он не сделает `count` перелётов; возвращает записанные перелёты. */
function followHops(world: World, target: Point, count: number, limitTicks = 6_000): Hop[] {
  const wisp = wispOf(world);
  const hops: Hop[] = [];
  for (let i = 0; i < limitTicks && hops.length < count; i++) {
    escort(world, target);
    const wasFlying = wisp.flying;
    const before = { x: wisp.x, y: wisp.y };
    run(world, 1);
    if (!wasFlying && wisp.flying) {
      hops.push({
        start: before,
        end: { x: wisp.hopX, y: wisp.hopY },
        toTarget: { x: target.x - before.x, y: target.y - before.y },
      });
    }
  }
  return hops;
}

/** Дождаться посадки текущего перелёта; игрок остаётся рядом. */
function untilLanded(world: World, target: Point, limitTicks = 2_000): void {
  const wisp = wispOf(world);
  for (let i = 0; i < limitTicks && wisp.flying; i++) {
    escort(world, target);
    run(world, 1);
  }
}

describe("огонёк ведёт шагами (Р214)", () => {
  it("после появления он ждёт у игрока, а следующий тик — первый шаг", () => {
    const world = appeared();
    const wisp = wispOf(world);
    expect(wisp.active).toBe(true);
    expect(wisp.flying).toBe(false);
    expect(wisp.hops).toBe(0);
    run(world, 1);
    expect(wisp.flying).toBe(true);
    expect(wisp.hops).toBe(1);
  });

  it("перелёт не короче шага и не длиннее шага с максимальным отклонением", () => {
    const world = appeared();
    const shrine = places(world)[0];
    const hops = followHops(world, shrine, 3);
    expect(hops).toHaveLength(3);
    for (const hop of hops) {
      const length = distance(hop.start, hop.end);
      expect(length).toBeGreaterThanOrEqual(WISP.hopUnits - 1e-6);
      expect(length).toBeLessThanOrEqual(WISP.hopUnits * (1 + WISP.swayMax) + 1e-6);
      // Боковое отклонение — доля шага из коридора.
      const ux = hop.toTarget.x / distance({ x: 0, y: 0 }, hop.toTarget);
      const uy = hop.toTarget.y / distance({ x: 0, y: 0 }, hop.toTarget);
      const along = (hop.end.x - hop.start.x) * ux + (hop.end.y - hop.start.y) * uy;
      const side = Math.abs(cross({ x: ux, y: uy }, { x: hop.end.x - hop.start.x, y: hop.end.y - hop.start.y }));
      expect(along).toBeCloseTo(WISP.hopUnits, 6);
      expect(side / WISP.hopUnits).toBeGreaterThanOrEqual(WISP.swayMin - 1e-9);
      expect(side / WISP.hopUnits).toBeLessThanOrEqual(WISP.swayMax + 1e-9);
    }
  });

  it("летит со скоростью speed единиц в секунду", () => {
    const world = appeared();
    const shrine = places(world)[0];
    const wisp = wispOf(world);
    escort(world, shrine);
    run(world, 1);
    expect(wisp.flying).toBe(true);
    const perTick = WISP.speed / TICKS_PER_SEC;
    // Все тики, кроме посадочного, — ровно по `speed / 60`.
    for (let i = 0; i < 20; i++) {
      const before = { x: wisp.x, y: wisp.y };
      escort(world, shrine);
      run(world, 1);
      expect(distance(before, wisp)).toBeCloseTo(perTick, 6);
    }
  });

  it("два шага подряд отклоняются в разные стороны от прямой «огонёк → цель»", () => {
    for (const seed of [1, 2, 3]) {
      const world = appeared(seed);
      const shrine = places(world)[0];
      const hops = followHops(world, shrine, 3);
      expect(hops.length, `seed ${seed}`).toBeGreaterThanOrEqual(3);
      const signs = hops.map((hop) => Math.sign(cross({ x: hop.end.x - hop.start.x, y: hop.end.y - hop.start.y }, hop.toTarget)));
      for (let i = 1; i < signs.length; i++) {
        expect(signs[i], `seed ${seed}, шаг ${i}`).not.toBe(0);
        expect(signs[i], `seed ${seed}, шаг ${i}`).toBe(-signs[i - 1]);
      }
    }
  });

  it("пока игрок дальше waitUnits, огонёк стоит после посадки; подошёл — следующий тик перелёт", () => {
    const world = appeared();
    const shrine = places(world)[0];
    const wisp = wispOf(world);
    followHops(world, shrine, 1);
    untilLanded(world, shrine);
    expect(wisp.flying).toBe(false);

    const waiting = { x: wisp.x, y: wisp.y };
    const hopsBefore = wisp.hops;
    // На единицу дальше порога: ждёт.
    standAt(world, wisp.x - (WISP.waitUnits + 1), wisp.y);
    run(world, 2 * TICKS_PER_SEC);
    expect([wisp.x, wisp.y]).toEqual([waiting.x, waiting.y]);
    expect(wisp.flying).toBe(false);
    expect(wisp.hops).toBe(hopsBefore);

    // Ровно на пороге (не дальше): уже ведёт.
    standAt(world, wisp.x - WISP.waitUnits, wisp.y);
    run(world, 1);
    expect(wisp.flying).toBe(true);
    expect(wisp.hops).toBe(hopsBefore + 1);
  });

  it("последний шаг — по прямой к краю круга цели, там огонёк ждёт", () => {
    const world = appeared();
    const shrine = places(world)[0];
    const wisp = wispOf(world);
    const hops: Hop[] = [];
    for (let guard = 0; guard < 40; guard++) {
      const made = followHops(world, shrine, 1, 400);
      if (made.length === 0) break;
      hops.push(made[0]);
      untilLanded(world, shrine);
      if (distance(wisp, shrine) <= SECRETS.shrine.radius + 1e-6) break;
    }
    expect(distance(wisp, shrine)).toBeCloseTo(SECRETS.shrine.radius, 6);
    expect(wisp.flying).toBe(false);

    // Последний перелёт лёг на прямую «огонёк → цель»: векторное произведение нулевое.
    const last = hops[hops.length - 1];
    const step = { x: last.end.x - last.start.x, y: last.end.y - last.start.y };
    expect(Math.abs(cross(step, last.toTarget)) / (distance({ x: 0, y: 0 }, step) * distance({ x: 0, y: 0 }, last.toTarget))).toBeLessThan(1e-9);
    // Остальные — с отклонением, и число шагов — разумное: зигзаг, а не один рывок.
    expect(hops.length).toBeGreaterThanOrEqual(3);

    // Ждёт на краю: игрок рядом (вне круга), огонёк не двигается.
    const waiting = { x: wisp.x, y: wisp.y };
    for (let i = 0; i < 120; i++) {
      escort(world, shrine);
      run(world, 1);
    }
    expect([wisp.x, wisp.y]).toEqual([waiting.x, waiting.y]);
    expect(shrine.found).toBe(false);
  });

  it("игрок вошёл в круг — огонёк ведёт к следующему месту", () => {
    const world = appeared();
    const [shrine, hoard] = places(world);
    const wisp = wispOf(world);
    standAt(world, shrine.x, shrine.y);
    run(world, 1);
    expect(shrine.found).toBe(true);

    standAt(world, wisp.x, wisp.y);
    const hops = followHops(world, hoard, 1);
    expect(hops).toHaveLength(1);
    // Цель шага — клад, а не капище: вектор на цель совпадает.
    expect(hops[0].toTarget.x).toBeCloseTo(hoard.x - hops[0].start.x, 6);
    expect(distance(hops[0].end, hoard)).toBeLessThan(distance(hops[0].start, hoard));
  });

  it("конечные точки шагов не выходят за границы карты", () => {
    const world = appeared();
    world.config.bounds = { halfWidth: 120, halfHeight: 120 };
    const shrine = places(world)[0];
    const hops = followHops(world, shrine, 2);
    expect(hops.length).toBeGreaterThan(0);
    for (const hop of hops) {
      expect(Math.abs(hop.end.x)).toBeLessThanOrEqual(120);
      expect(Math.abs(hop.end.y)).toBeLessThanOrEqual(120);
    }
  });
});

describe("огонёк гаснет, когда вести некуда (Р214)", () => {
  function extinguished(): World {
    const world = appeared();
    for (const site of places(world)) site.found = true;
    run(world, 2);
    return world;
  }

  it("все места найдены — огонёк погас: использован, не активен, не виден", () => {
    const world = extinguished();
    const wisp = wispOf(world);
    expect(wisp.used).toBe(true);
    expect(wisp.active).toBe(false);
    expect(wisp.visible).toBe(false);
  });

  it("летящий огонёк сначала долетает, потом гаснет", () => {
    const world = appeared();
    const wisp = wispOf(world);
    run(world, 1);
    expect(wisp.flying).toBe(true);
    for (const site of places(world)) site.found = true;
    expect(wisp.used).toBe(false);
    run(world, 2 * TICKS_PER_SEC);
    expect(wisp.flying).toBe(false);
    expect(wisp.used).toBe(true);
    expect(wisp.active).toBe(false);
  });

  it("в итог забега как использованный огонёк не входит, найденный — входит", () => {
    const world = extinguished();
    expect(secretKindsUsed(world)).not.toContain("wisp");
    expect(secretKindsFound(world)).toContain("wisp");
    const result = buildRunResult(world, { runId: "r", seed: 1, outcome: "died", startingWeaponId: "spark", contentHash: "00000000" });
    expect(result.secrets.used).not.toContain("wisp");
    expect(result.secrets.found).toContain("wisp");
  });

  it("погасание в журнал использованных не пишется", () => {
    const world = extinguished();
    const events = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 });
    expect(events.used.map((entry) => entry.kind)).not.toContain("wisp");
  });

  it("повторного появления нет", () => {
    const world = extinguished();
    const wisp = wispOf(world);
    standAt(world, 300, 300);
    run(world, 5 * TICKS_PER_SEC);
    expect(wisp.active).toBe(false);
    expect(wisp.visible).toBe(false);
    expect(wisp.used).toBe(true);
    const found = takeSecretEvents(world, { found: 0, used: 0, blessings: 0 }).found;
    expect(found.filter((entry) => entry.kind === "wisp")).toHaveLength(1);
  });

  it("нашёл всё до 90-й секунды — огонёк появляется и сразу гаснет, не оставляя метки на радаре", () => {
    const world = setup();
    standAt(world, 0, 0);
    run(world, APPEAR_TICKS - 1);
    for (const site of places(world)) site.found = true;
    run(world, 5);
    const wisp = wispOf(world);
    expect(wisp.used).toBe(true);
    expect(wisp.active).toBe(false);
    expect(wisp.visible).toBe(false);
  });
});

describe("детерминизм огонька", () => {
  /** Один и тот же путь игрока: идти за огоньком к ближайшему месту, потом стоять. */
  function track(seed: number, ticks: number): Point[] {
    const world = appeared(seed);
    const wisp = wispOf(world);
    const path: Point[] = [];
    for (let i = 0; i < ticks; i++) {
      const target = places(world).find((site) => !site.found);
      if (target !== undefined) escort(world, target);
      run(world, 1);
      path.push({ x: wisp.x, y: wisp.y });
    }
    return path;
  }

  it("два мира с одним seed и одной дорогой игрока — одни координаты на каждом тике", () => {
    expect(track(7, 900)).toEqual(track(7, 900));
  });

  it("другой seed — другая дорога (отклонение берётся из потока тайников)", () => {
    expect(track(7, 900)).not.toEqual(track(8, 900));
  });

  it("world.rng с огоньком не сдвигается", () => {
    const world = appeared();
    const before = world.rng.getState();
    const shrine = places(world)[0];
    for (let i = 0; i < 300; i++) {
      escort(world, shrine);
      run(world, 1);
    }
    expect(wispOf(world).hops).toBeGreaterThan(0);
    expect(world.rng.getState()).toBe(before);
  });

  it("до появления огонька поток тайников не тратится: раскладка и капище не сдвигаются", () => {
    const world = setup();
    const created = world.secrets.rng.getState();
    standAt(world, 0, 0);
    run(world, APPEAR_TICKS - 1);
    expect(world.secrets.rng.getState()).toBe(created);
  });

  it("шаг тратит ровно одну выборку потока тайников", () => {
    const world = appeared();
    const wisp = wispOf(world);
    const shrine = places(world)[0];
    const before = world.secrets.rng.getState();
    escort(world, shrine);
    run(world, 1);
    expect(wisp.flying).toBe(true);
    const spent = world.secrets.rng.getState();
    expect(spent).not.toBe(before);
    // Полёт и ожидание поток не трогают.
    run(world, 10);
    expect(world.secrets.rng.getState()).toBe(spent);
  });
});
