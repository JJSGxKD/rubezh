import type { CordonRingDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { damageEnemy } from "../src/game/sim/combat";
import { checksumWorld } from "../src/game/sim/checksum";
import { CORDON_INNER_RADIUS_MUL, CORDON_INNER_SEC } from "../src/game/sim/cordon";
import { vectorLength } from "../src/game/sim/vector";
import { advanceRun, aliveGuards, BOSS, CORDON_RING, createCordonRun, ELITE, stepRun, type CordonRun } from "./helpers/scripted-run";

// Внутри строя (docs/35-stage4-plan.md Р166, tasks/T-0335): вместе с кольцом
// может появиться элита или босс — место выбрано при старте, через
// CORDON_INNER_SEC они выходят с телеграфом. Они не стражи: кольцо их не
// считает и по времени их не убирает.

const ELITE_TYPE = 2;
const BOSS_TYPE = 3;

const ringWith = (inner: CordonRingDef["inner"], patch: Partial<CordonRingDef> = {}): CordonRingDef => ({ ...CORDON_RING, inner, ...patch });

const run = (inner: CordonRingDef["inner"], patch: Partial<CordonRingDef> = {}, extra: { maxEnemies?: number } = {}): CordonRun =>
  createCordonRun({ ring: ringWith(inner, patch), enemies: [ELITE, BOSS], ...extra });

/** Индексы живых врагов нужного типа. */
function alive(world: CordonRun["world"], typeIndex: number): number[] {
  const found: number[] = [];
  for (let i = 0; i < world.enemies.count; i++) {
    if (world.enemies.alive[i] === 1 && world.enemies.type[i] === typeIndex) found.push(i);
  }
  return found;
}

function fromCenter(r: CordonRun, index: number): number {
  return vectorLength(r.world.enemies.x[index] - r.world.cordon.centerX, r.world.enemies.y[index] - r.world.cordon.centerY);
}

/** Крутит, пока не появится первый враг типа; возвращает, сколько секунд прошло. */
function untilAppears(r: CordonRun, typeIndex: number): number {
  let ticks = 0;
  while (alive(r.world, typeIndex).length === 0 && ticks < 600) {
    stepRun(r);
    ticks++;
  }
  return ticks / 60;
}

describe("появление внутренних врагов", () => {
  it("сразу после старта ждёт, в мире элиты нет; через CORDON_INNER_SEC выходит на половине радиуса", () => {
    const r = run([{ enemy: "elite_test", count: 1 }]);
    stepRun(r);
    expect(r.world.cordon.pending).toHaveLength(1);
    expect(alive(r.world, ELITE_TYPE)).toHaveLength(0);

    const waited = untilAppears(r, ELITE_TYPE);
    expect(Math.abs(waited - CORDON_INNER_SEC)).toBeLessThanOrEqual(0.1);
    const [elite] = alive(r.world, ELITE_TYPE);
    if (elite === undefined) throw new Error("нет элиты");
    expect(Math.abs(fromCenter(r, elite) - CORDON_RING.radius * CORDON_INNER_RADIUS_MUL)).toBeLessThanOrEqual(1);
    expect(r.world.cordon.pending).toEqual([]);
  });

  it("три элиты — на разных направлениях", () => {
    const r = run([{ enemy: "elite_test", count: 3 }]);
    untilAppears(r, ELITE_TYPE);
    const elites = alive(r.world, ELITE_TYPE);
    expect(elites).toHaveLength(3);
    for (let a = 0; a < elites.length; a++) {
      for (let b = a + 1; b < elites.length; b++) {
        const first = elites[a] ?? 0;
        const second = elites[b] ?? 0;
        const gap = vectorLength(r.world.enemies.x[first] - r.world.enemies.x[second], r.world.enemies.y[first] - r.world.enemies.y[second]);
        expect(gap).toBeGreaterThan(0);
      }
    }
  });

  it("несколько записей — одним списком: и элита, и босс", () => {
    const r = run([{ enemy: "elite_test", count: 2 }, { enemy: "boss_test", count: 1 }]);
    stepRun(r);
    expect(r.world.cordon.pending).toHaveLength(3);
    advanceRun(r, CORDON_INNER_SEC + 0.1);
    expect(alive(r.world, ELITE_TYPE)).toHaveLength(2);
    expect(alive(r.world, BOSS_TYPE)).toHaveLength(1);
  });
});

describe("fromSec", () => {
  it("запись, у которой fromSec позже, чем идёт забег, пропущена и случайность не тратит", () => {
    const withSkipped = run([{ enemy: "elite_test", count: 1, fromSec: 600 }]);
    const without = createCordonRun({ ring: CORDON_RING, enemies: [ELITE, BOSS] });
    stepRun(withSkipped);
    stepRun(without);

    expect(withSkipped.world.cordon.pending).toEqual([]);
    expect(checksumWorld(withSkipped.world)).toBe(checksumWorld(without.world));
  });

  it("на 600-й секунде запись действует", () => {
    const r = run([{ enemy: "elite_test", count: 1, fromSec: 600 }]);
    r.world.stats.elapsedSec = 600;
    stepRun(r);
    expect(r.world.cordon.pending).toHaveLength(1);
  });
});

describe("внутренние — не стражи", () => {
  it("убиты все стражи: кольцо кончилось, элита жива", () => {
    const r = run([{ enemy: "elite_test", count: 1 }]);
    advanceRun(r, CORDON_INNER_SEC + 0.1);
    expect(alive(r.world, ELITE_TYPE)).toHaveLength(1);

    for (const index of aliveGuards(r.world)) damageEnemy(r.world, index, 1e9, 0);
    stepRun(r);

    expect(r.world.cordon.active).toBe(false);
    expect(alive(r.world, ELITE_TYPE)).toHaveLength(1);
  });

  it("кольцо кончилось по времени: стражи исчезли, внутренние выжили", () => {
    const r = run([{ enemy: "elite_test", count: 1 }, { enemy: "boss_test", count: 1 }], { lifeSec: 5 });
    advanceRun(r, 6);

    expect(r.world.cordon.active).toBe(false);
    expect(aliveGuards(r.world)).toHaveLength(0);
    expect(alive(r.world, ELITE_TYPE)).toHaveLength(1);
    expect(alive(r.world, BOSS_TYPE)).toHaveLength(1);
  });

  it("кольцо кончилось раньше, чем вышли внутренние: ожидающие очищены, элита не появилась", () => {
    const r = run([{ enemy: "elite_test", count: 1 }], { lifeSec: 0.5 });
    advanceRun(r, 0.6);
    expect(r.world.cordon.active).toBe(false);
    expect(r.world.cordon.pending).toEqual([]);

    advanceRun(r, CORDON_INNER_SEC + 0.5);
    expect(alive(r.world, ELITE_TYPE)).toHaveLength(0);
  });
});

describe("краевые случаи", () => {
  it("слотов нет: пул занят стражами, внутренний не появляется, исключения нет", () => {
    const r = run([{ enemy: "elite_test", count: 1 }], {}, { maxEnemies: 40 });
    expect(() => advanceRun(r, CORDON_INNER_SEC + 0.5)).not.toThrow();
    expect(aliveGuards(r.world)).toHaveLength(40);
    expect(alive(r.world, ELITE_TYPE)).toHaveLength(0);
    expect(r.world.cordon.pending).toEqual([]);
  });

  it("неизвестный id пропущен без ошибки", () => {
    const r = run([{ enemy: "no_such_enemy", count: 2 }]);
    expect(() => advanceRun(r, CORDON_INNER_SEC + 0.5)).not.toThrow();
    expect(r.world.cordon.pending).toEqual([]);
    expect(r.world.cordon.active).toBe(true);
  });

  it("кольцо без стражей (ни один не встал) внутренних не создаёт", () => {
    const r = run([{ enemy: "elite_test", count: 1 }], {}, { maxEnemies: 1 });
    // единственный слот занят до события
    r.world.enemies.alive[0] = 1;
    r.world.enemies.aliveCount = 1;
    r.world.enemies.count = 1;
    r.world.enemies.type[0] = 1;
    advanceRun(r, CORDON_INNER_SEC + 0.5);
    expect(r.world.cordon.active).toBe(false);
    expect(r.world.cordon.pending).toEqual([]);
  });

  it("второе кольцо не наследует ожидающих от первого", () => {
    const first = ringWith([{ enemy: "elite_test", count: 1 }], { lifeSec: 0.5 });
    const second = ringWith(undefined, { lifeSec: 30 });
    const r = createCordonRun({
      enemies: [ELITE, BOSS],
      timeline: [
        { fromSec: 0, spawns: [], events: [{ kind: "cordon", enemy: "guard", count: 40, ring: first }] },
        { fromSec: 3, spawns: [], events: [{ kind: "cordon", enemy: "guard", count: 40, ring: second }] },
      ],
    });
    advanceRun(r, 3.2);
    expect(r.world.cordon.active).toBe(true);
    expect(r.world.cordon.pending).toEqual([]);
    expect(alive(r.world, ELITE_TYPE)).toHaveLength(0);
  });
});
