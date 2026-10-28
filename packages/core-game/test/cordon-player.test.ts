import { describe, expect, it } from "vitest";
import { CORDON_FORM_SEC } from "../src/game/patterns";
import { damageEnemy } from "../src/game/sim/combat";
import { pushPlayerOutOfGuards } from "../src/game/sim/cordon";
import { vectorLength } from "../src/game/sim/vector";
import { spawnEnemy } from "../src/game/sim/world";
import { advanceRun, aliveGuards, CORDON_RING, createCordonRun, GUARD, stepRun, type CordonRun } from "./helpers/scripted-run";

// Тело стража непроходимо для игрока (Р112): игрок выталкивается из него и
// скользит вдоль строя, а проход открывается там, где стражи убиты. Прочие
// враги игрока по-прежнему не блокируют.

/** Кольцо, которое почти не сжимается: тест смотрит на тело, а не на сжатие. */
const SLOW_RING = { ...CORDON_RING, shrinkPerSec: 1, lifeSec: 120 };

const GUARD_RADIUS = 14;
const PLAYER_RADIUS = 10;

/** Собранный строй: сорок стражей заняли места, игрок в центре. */
function assembled(ring = SLOW_RING, options: { playerHp?: number } = {}): CordonRun {
  const run = createCordonRun({ ring, ...options });
  advanceRun(run, 30);
  expect(aliveGuards(run.world)).toHaveLength(40);
  return run;
}

function distanceFromCenter(run: CordonRun): number {
  return vectorLength(run.world.player.x - run.world.cordon.centerX, run.world.player.y - run.world.cordon.centerY);
}

/** Расстояние от игрока до ближайшего живого стража. */
function nearestGuard(run: CordonRun): number {
  let best = Number.POSITIVE_INFINITY;
  for (const index of aliveGuards(run.world)) {
    best = Math.min(best, vectorLength(run.world.player.x - run.world.enemies.x[index], run.world.player.y - run.world.enemies.y[index]));
  }
  return best;
}

const DIRECTIONS = [
  { moveX: 1, moveY: 0 },
  { moveX: 1, moveY: 1 },
  { moveX: 0, moveY: 1 },
  { moveX: -1, moveY: 1 },
  { moveX: -1, moveY: 0 },
  { moveX: -1, moveY: -1 },
  { moveX: 0, moveY: -1 },
  { moveX: 1, moveY: -1 },
];

describe("кольцо держит игрока", () => {
  it("двадцать секунд бега в восемь сторон: ни на одном тике игрок не дальше радиуса кольца", () => {
    const run = assembled();
    const ticks = 20 * 60;
    for (let tick = 0; tick < ticks; tick++) {
      stepRun(run, DIRECTIONS[Math.floor(tick / 150) % DIRECTIONS.length] ?? DIRECTIONS[0]!);
      expect(distanceFromCenter(run), `тик ${String(tick)}`).toBeLessThanOrEqual(run.world.cordon.radius);
    }
  });

  it("упёрся в стража на полной скорости: тело не входит глубже суммы радиусов минус единица", () => {
    const run = assembled();
    let closest = Number.POSITIVE_INFINITY;
    for (let tick = 0; tick < 6 * 60; tick++) {
      stepRun(run, { moveX: 1, moveY: 0 });
      closest = Math.min(closest, nearestGuard(run));
    }
    expect(closest).toBeGreaterThanOrEqual(GUARD_RADIUS + PLAYER_RADIUS - 1);
    // и он действительно дошёл до строя, а не стоял посреди
    expect(distanceFromCenter(run)).toBeGreaterThan(run.world.cordon.radius - 40);
  });

  it("скольжение: упёршись в строй и нажав вдоль него, игрок идёт по строю, а не прилипает", () => {
    const run = assembled();
    advanceRun(run, 3, { moveX: 1, moveY: 0 });
    const yBefore = run.world.player.y;

    advanceRun(run, 3, { moveX: 0, moveY: 1 });

    expect(Math.abs(run.world.player.y - yBefore)).toBeGreaterThan(60);
    expect(distanceFromCenter(run)).toBeLessThanOrEqual(run.world.cordon.radius);
  });

  it("выталкивание: скорость вглубь тела гасится, вдоль — остаётся, игрок встаёт на сумму радиусов", () => {
    const run = createCordonRun({ count: 1 });
    stepRun(run);
    const [guard] = aliveGuards(run.world);
    if (guard === undefined) throw new Error("нет стража");
    run.world.enemies.x[guard] = 50;
    run.world.enemies.y[guard] = 0;
    run.world.player.x = 30;
    run.world.player.y = 0;
    run.world.player.vx = 100;
    run.world.player.vy = 80;

    pushPlayerOutOfGuards(run.world);

    expect(run.world.player.x).toBeCloseTo(50 - GUARD_RADIUS - PLAYER_RADIUS, 6);
    expect(run.world.player.vx).toBe(0);
    expect(run.world.player.vy).toBe(80);
  });

  it("выталкивание: совпавшие центры не дают деления на ноль, скорость от стража не гасится", () => {
    const run = createCordonRun({ count: 1 });
    stepRun(run);
    const [guard] = aliveGuards(run.world);
    if (guard === undefined) throw new Error("нет стража");
    run.world.enemies.x[guard] = 10;
    run.world.enemies.y[guard] = 10;
    run.world.player.x = 10;
    run.world.player.y = 10;

    pushPlayerOutOfGuards(run.world);

    expect(Number.isFinite(run.world.player.x)).toBe(true);
    expect(Number.isFinite(run.world.player.y)).toBe(true);
    expect(run.world.player.x).toBeCloseTo(10 + GUARD_RADIUS + PLAYER_RADIUS, 6);
  });
});

describe("проход", () => {
  it("убиты четыре соседних стража: игрок, бегущий через дыру, оказывается за кольцом", () => {
    const run = assembled();
    const radius = run.world.cordon.radius;
    const nearest = aliveGuards(run.world)
      .map((index) => ({ index, d: vectorLength(run.world.enemies.x[index] - radius, run.world.enemies.y[index]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    for (const { index } of nearest) damageEnemy(run.world, index, 1e9, 0);

    advanceRun(run, 8, { moveX: 1, moveY: 0 });

    expect(aliveGuards(run.world)).toHaveLength(36);
    expect(distanceFromCenter(run)).toBeGreaterThan(run.world.cordon.radius + 30);
  });
});

describe("сжатие толкает игрока", () => {
  it("игрок у кромки: строй сжимается, игрока теснит к центру, в тело страж не входит", () => {
    const ring = { radius: 300, minRadius: 80, shrinkPerSec: 6, lifeSec: 120 };
    const run = createCordonRun({ ring });
    // строй собран сразу, но ещё не сжат до предела: впереди не меньше десяти секунд сжатия
    advanceRun(run, CORDON_FORM_SEC + 0.2);
    expect(aliveGuards(run.world)).toHaveLength(40);
    const radius = run.world.cordon.radius;
    expect(radius - 10 * ring.shrinkPerSec).toBeGreaterThan(ring.minRadius);
    run.world.player.x = run.world.cordon.centerX + radius - GUARD_RADIUS - PLAYER_RADIUS - 1;
    run.world.player.y = run.world.cordon.centerY;
    const start = distanceFromCenter(run);

    let closest = Number.POSITIVE_INFINITY;
    for (let tick = 0; tick < 10 * 60; tick++) {
      stepRun(run);
      closest = Math.min(closest, nearestGuard(run));
    }

    expect(distanceFromCenter(run)).toBeLessThan(start - 40);
    expect(closest).toBeGreaterThanOrEqual(GUARD_RADIUS + PLAYER_RADIUS - 1);
  });
});

describe("прочие враги и урон", () => {
  it("обычный враг тело игрока не толкает и игрока не блокирует: игрок проходит сквозь толпу", () => {
    const run = createCordonRun({ timeline: [{ fromSec: 0, spawns: [], events: [] }] });
    for (let k = 0; k < 12; k++) spawnEnemy(run.world, 1, 30 + (k % 4) * 6, (k - 6) * 5);

    advanceRun(run, 1.5, { moveX: 1, moveY: 0 });

    expect(run.world.player.x).toBeGreaterThan(150);
  });

  it("касание: игрок рядом со стражем теряет здоровье на его damage, не чаще раза за 0,6 секунды", () => {
    const run = createCordonRun({ timeline: [{ fromSec: 0, spawns: [], events: [] }], playerHp: 100 });
    spawnEnemy(run.world, 0, 20, 0);

    advanceRun(run, 3);

    const lost = 100 - run.world.player.hp;
    // страж бьёт на 5, интервал 0,6 с: за три секунды от четырёх до шести ударов
    expect(lost % GUARD.damage).toBe(0);
    expect(lost / GUARD.damage).toBeGreaterThanOrEqual(4);
    expect(lost / GUARD.damage).toBeLessThanOrEqual(6);
  });

  it("мёртвый игрок: выталкивание не вызывается, исключений нет", () => {
    const run = assembled();
    run.world.player.alive = false;
    run.world.player.hp = 0;
    expect(() => advanceRun(run, 2, { moveX: 1, moveY: 0 })).not.toThrow();
  });
});
