import type { MapDef, TimelineSegmentDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { MAPS } from "../src/content/maps";
import { CORDON_FORM_SEC, CORDON_PHASE } from "../src/game/patterns";
import { damageEnemy } from "../src/game/sim/combat";
import { checksumWorld } from "../src/game/sim/checksum";
import { vectorLength } from "../src/game/sim/vector";
import { spawnEnemy, TICK_SEC } from "../src/game/sim/world";
import { advanceRun, aliveGuards, CORDON_RING, createCordonRun, stepRun } from "./helpers/scripted-run";

// Кольцо стражей — событие таймлайна (docs/35-stage4-plan.md Р112, tasks/T-0170):
// стражи приходят снаружи, занимают места вокруг неподвижного центра и вместе
// с кольцом сжимаются. Здесь — само кольцо без игрока; тело стража — в
// cordon-player.test.ts.

/** Расстояние до центра кольца. */
function fromCenter(run: ReturnType<typeof createCordonRun>, index: number): number {
  return vectorLength(run.world.enemies.x[index] - run.world.cordon.centerX, run.world.enemies.y[index] - run.world.cordon.centerY);
}

/** Строй сформирован: вспышка погасла, дальше только сжатие. */
const FORMED_SEC = CORDON_FORM_SEC + 0.2;

describe("строй на радиусе кольца", () => {
  it("событие на нулевой секунде: сорок стражей на радиусе кольца, центр — там, где стоял игрок", () => {
    const run = createCordonRun();
    stepRun(run);
    const guards = aliveGuards(run.world);

    expect(guards).toHaveLength(40);
    expect(run.world.cordon.active).toBe(true);
    expect(run.world.cordon.centerX).toBe(run.world.player.x);
    expect(run.world.cordon.centerY).toBe(run.world.player.y);
    // строй стоит сразу на радиусе кольца, а не на радиусе спавна за краем экрана
    for (const index of guards) expect(Math.abs(fromCenter(run, index) - CORDON_RING.radius)).toBeLessThanOrEqual(1);
  });

  it("центр — позиция игрока в тик события, а не нуль", () => {
    const run = createCordonRun();
    run.world.player.x = 123;
    run.world.player.y = -45;
    stepRun(run);
    expect([run.world.cordon.centerX, run.world.cordon.centerY]).toEqual([123, -45]);
  });

  it("стражи стоят на местах сразу: после вспышки фаза «держит место», на расстоянии радиуса кольца", () => {
    const run = createCordonRun();
    advanceRun(run, FORMED_SEC);
    const guards = aliveGuards(run.world);

    expect(guards).toHaveLength(40);
    expect(run.world.cordon.radius).toBeGreaterThan(CORDON_RING.minRadius);
    for (const index of guards) {
      expect(run.world.enemies.phase[index]).toBe(CORDON_PHASE.holding);
      expect(Math.abs(fromCenter(run, index) - run.world.cordon.radius)).toBeLessThanOrEqual(5);
    }
  });
});

describe("сжатие", () => {
  it("радиус сжимается на shrinkPerSec в секунду, стражи идут за ним; на minRadius останавливается", () => {
    const run = createCordonRun();
    advanceRun(run, FORMED_SEC);
    const before = run.world.cordon.radius;

    advanceRun(run, 3);
    expect(before - run.world.cordon.radius).toBeCloseTo(CORDON_RING.shrinkPerSec * 3, 0);
    for (const index of aliveGuards(run.world)) expect(Math.abs(fromCenter(run, index) - run.world.cordon.radius)).toBeLessThanOrEqual(5);

    // радиус кончился на пределе раньше, чем вышло время кольца
    advanceRun(run, 25 - FORMED_SEC - 3);
    expect(run.world.cordon.active).toBe(true);
    expect(run.world.cordon.radius).toBe(CORDON_RING.minRadius);
    advanceRun(run, 4);
    expect(run.world.cordon.radius).toBe(CORDON_RING.minRadius);
    for (const index of aliveGuards(run.world)) expect(Math.abs(fromCenter(run, index) - CORDON_RING.minRadius)).toBeLessThanOrEqual(5);
  });

  it("центр не идёт за игроком", () => {
    const run = createCordonRun();
    advanceRun(run, 2);
    const center = [run.world.cordon.centerX, run.world.cordon.centerY];
    run.world.player.x += 100;
    advanceRun(run, 1);
    expect([run.world.cordon.centerX, run.world.cordon.centerY]).toEqual(center);
  });
});

describe("конец кольца", () => {
  it("по времени: стражи исчезают без убийства — ни счёта, ни добычи", () => {
    const run = createCordonRun({ loot: true });
    advanceRun(run, CORDON_RING.lifeSec + 1);

    expect(aliveGuards(run.world)).toHaveLength(0);
    expect(run.world.cordon.active).toBe(false);
    expect(run.world.stats.enemiesKilled).toBe(0);
    expect(run.world.gems.aliveCount).toBe(0);
  });

  it("по убийству: когда убиты все, на следующем тике кольцо неактивно, добыча — по обычным правилам", () => {
    const run = createCordonRun({ loot: true });
    advanceRun(run, FORMED_SEC);
    for (const index of aliveGuards(run.world)) damageEnemy(run.world, index, 1e9, 0);
    stepRun(run);

    expect(run.world.cordon.active).toBe(false);
    expect(run.world.stats.enemiesKilled).toBe(40);
    expect(run.world.gems.aliveCount).toBeGreaterThan(0);
  });

  it("убит не весь строй — кольцо живёт и сжимается дальше", () => {
    const run = createCordonRun();
    advanceRun(run, FORMED_SEC);
    for (const index of aliveGuards(run.world).slice(0, 39)) damageEnemy(run.world, index, 1e9, 0);
    advanceRun(run, 1);
    expect(run.world.cordon.active).toBe(true);
    expect(aliveGuards(run.world)).toHaveLength(1);
  });
});

describe("одно кольцо за раз", () => {
  const event = (fromSec: number): TimelineSegmentDef => ({
    fromSec,
    spawns: [],
    events: [{ kind: "cordon", enemy: "guard", count: 40, ring: CORDON_RING }],
  });

  it("второе событие при активном кольце пропускается целиком; после конца первого — запускается", () => {
    const run = createCordonRun({ timeline: [event(0), event(3), event(50)] });
    advanceRun(run, 5);
    expect(aliveGuards(run.world)).toHaveLength(40);

    advanceRun(run, 40);
    // кольцо вышло по времени, третье событие ещё не пришло
    expect(run.world.cordon.active).toBe(false);
    expect(aliveGuards(run.world)).toHaveLength(0);

    advanceRun(run, 6);
    expect(run.world.cordon.active).toBe(true);
    expect(aliveGuards(run.world)).toHaveLength(40);
  });
});

describe("потолок живых", () => {
  it("кольцо приходит целиком, даже когда поле заполнено до потолка", () => {
    const filler: TimelineSegmentDef = { fromSec: 0, maxAlive: 50, spawns: [{ enemy: "rat", perSec: 300 }] };
    const cordon: TimelineSegmentDef = { fromSec: 2, maxAlive: 50, spawns: [{ enemy: "rat", perSec: 300 }], events: [{ kind: "cordon", enemy: "guard", count: 40, ring: CORDON_RING }] };
    const run = createCordonRun({ timeline: [filler, cordon] });
    advanceRun(run, 1.9);
    expect(run.world.enemies.aliveCount).toBe(50);

    advanceRun(run, 0.2);
    expect(aliveGuards(run.world)).toHaveLength(40);
    expect(run.world.enemies.aliveCount).toBeGreaterThanOrEqual(90);
  });

  it("пул на тридцать слотов: приходит тридцать стражей, исключения нет", () => {
    const run = createCordonRun({ maxEnemies: 30 });
    expect(() => advanceRun(run, 1)).not.toThrow();
    expect(aliveGuards(run.world)).toHaveLength(30);
    expect(run.world.cordon.active).toBe(true);
  });

  it("ни один страж не поместился — кольцо остаётся неактивным", () => {
    const run = createCordonRun({ maxEnemies: 1 });
    // единственный слот занят до события
    spawnEnemy(run.world, 1, 5000, 5000);
    advanceRun(run, 1);
    expect(aliveGuards(run.world)).toHaveLength(0);
    expect(run.world.cordon.active).toBe(false);
  });
});

describe("страж на своём месте", () => {
  it("не уносится вперёд, как отставший: игрок далеко, а строй стоит", () => {
    const run = createCordonRun();
    advanceRun(run, FORMED_SEC);
    const recycled = run.world.stats.enemiesRecycled;
    const before = aliveGuards(run.world).map((index) => [run.world.enemies.x[index], run.world.enemies.y[index]]);

    run.world.player.x = run.world.cordon.centerX + run.world.config.view.retentionRadius * 2;
    advanceRun(run, 0.5);

    expect(run.world.stats.enemiesRecycled).toBe(recycled);
    expect(aliveGuards(run.world)).toHaveLength(40);
    aliveGuards(run.world).forEach((index, k) => {
      const [x, y] = before[k] ?? [0, 0];
      expect(vectorLength(run.world.enemies.x[index] - x, run.world.enemies.y[index] - y)).toBeLessThan(10);
    });
  });

  it("замороженный страж стоит, остальные идут", () => {
    const run = createCordonRun();
    advanceRun(run, 3);
    const [frozen, free] = aliveGuards(run.world);
    if (frozen === undefined || free === undefined) throw new Error("нет стражей");
    run.world.enemies.frozenTimer[frozen] = 10;
    const frozenAt = [run.world.enemies.x[frozen], run.world.enemies.y[frozen]];
    const freeAt = [run.world.enemies.x[free], run.world.enemies.y[free]];

    advanceRun(run, 1);

    expect([run.world.enemies.x[frozen], run.world.enemies.y[frozen]]).toEqual(frozenAt);
    expect([run.world.enemies.x[free], run.world.enemies.y[free]]).not.toEqual(freeAt);
  });

  it("карта с границей и игрок у стены: ни NaN, все стражи внутри карты", () => {
    const bounded: MapDef = { ...(MAPS[0] as MapDef), bounds: { halfWidth: 1800 } };
    const run = createCordonRun({ map: bounded });
    run.world.player.x = 1750;
    advanceRun(run, 25);

    const guards = aliveGuards(run.world);
    expect(guards.length).toBeGreaterThan(0);
    for (const index of guards) {
      expect(Number.isFinite(run.world.enemies.x[index])).toBe(true);
      expect(Number.isFinite(run.world.enemies.y[index])).toBe(true);
      expect(Math.abs(run.world.enemies.x[index])).toBeLessThanOrEqual(1800);
    }
  });
});

describe("повторяемость", () => {
  it("один seed и один ввод — одна сумма; с кольцом и без него суммы разные", () => {
    const sum = (timeline?: TimelineSegmentDef[]) => {
      const run = createCordonRun({ seed: 9, ...(timeline === undefined ? {} : { timeline }) });
      advanceRun(run, 12);
      return checksumWorld(run.world);
    };
    expect(sum()).toBe(sum());
    expect(sum([{ fromSec: 0, spawns: [], events: [] }])).not.toBe(sum());
  });

  it("шаг мира — шестьдесят в секунду: допуск тестов на тик согласован с TICK_SEC", () => {
    expect(TICK_SEC).toBeCloseTo(1 / 60, 10);
  });
});
