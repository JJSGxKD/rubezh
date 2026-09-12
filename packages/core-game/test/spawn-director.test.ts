import type { EndlessCurveDef, TimelineSegmentDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { WEAPONS } from "../src/content/weapons";
import { createTimelineDirector } from "../src/game/sim/director";
import { DEFAULT_SIM_CONFIG, createWorld, type World } from "../src/game/sim/world";
import { planSegment, segmentStartSec } from "../src/game/sim/timeline";
import { findTimelineProblems } from "../src/game/sim/timeline-content";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";

// Директор спавна и кривая сложности (docs/26-stage2-plan.md, WP4.4).

/** Сколько врагов может добавить сверх потолка распад делящегося. */
const SPLIT_SLACK = 8;

function makeWorld(seed = 1): World {
  return createWorld({
    seed,
    enemies: ENEMIES,
    weapons: WEAPONS,
    map: MAPS[0],
    config: {
      progressionEnabled: false,
      // Бессмертный: проверяются свойства спавна, а не то, сколько проживёт
      // неподвижная мишень.
      player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 },
    },
  });
}

function runDirector(world: World, seconds: number, onTick?: () => void): void {
  const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
  for (let tick = 0; tick < seconds * 60; tick++) {
    director.update(world, 1 / 60);
    stepWorld(world, IDLE_INPUT);
    onTick?.();
  }
}

describe("таймлайн спавна", () => {
  it("идёт непрерывным потоком, а не волнами с паузами", () => {
    const world = makeWorld();
    const counts: number[] = [];
    let tick = 0;

    runDirector(world, 40, () => {
      if (++tick % 60 === 0) counts.push(world.stats.enemiesSpawned);
    });

    // Каждую секунду появляется хоть кто-то: пауза между волнами — это ровно
    // то, от чего уходит непрерывный таймлайн.
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i], `секунда ${i + 1}`).toBeGreaterThan(counts[i - 1]);
    }
  });

  it("двигает отрезки по времени и не откатывает их назад", () => {
    const world = makeWorld();
    let previous = -1;

    runDirector(world, 400, () => {
      expect(world.difficulty.segment).toBeGreaterThanOrEqual(previous);
      previous = world.difficulty.segment;
    });

    // Пять минут расписаны руками, дальше отрезки генерируются: за 400 секунд
    // забег обязан уйти в генерацию.
    expect(world.difficulty.segment).toBeGreaterThan(TIMELINE.length - 1);
  });

  it("не превышает потолок живых", () => {
    const world = makeWorld();
    let peak = 0;

    runDirector(world, 420, () => {
      peak = Math.max(peak, world.enemies.aliveCount);
      // Запас на распад делящихся: потомки появляются в обход директора, по
      // смерти родителя, и потолок для них — не преграда, иначе механика
      // молча исчезала бы у потолка.
      expect(world.enemies.aliveCount).toBeLessThanOrEqual(
        world.difficulty.maxAlive + SPLIT_SLACK,
      );
    });

    // Прогон должен быть настоящим: пустой мир проходит проверку впустую.
    expect(peak).toBeGreaterThan(50);
  });

  it("повторяется побитово на одном seed, включая сгенерированную часть", () => {
    const first = makeWorld(4242);
    const second = makeWorld(4242);
    runDirector(first, 420);
    runDirector(second, 420);

    expect(second.stats.enemiesSpawned).toBe(first.stats.enemiesSpawned);
    expect(second.difficulty).toEqual(first.difficulty);
    expect(Array.from(second.stats.killsByType)).toEqual(Array.from(first.stats.killsByType));
  });
});

describe("кривая бесконечного режима", () => {
  it("не даёт бюджету угрозы убывать ни на одном отрезке", () => {
    const world = makeWorld();
    let previous = 0;

    for (let index = 0; index < TIMELINE.length + 30; index++) {
      const plan = planSegment(world, TIMELINE, ENDLESS_CURVE, index);
      expect(plan.threatPerSec, `отрезок ${index}`).toBeGreaterThanOrEqual(previous);
      previous = plan.threatPerSec;
    }
  });

  it("после потолка живых растит сложность здоровьем и уроном", () => {
    const world = makeWorld();
    const first = planSegment(world, TIMELINE, ENDLESS_CURVE, TIMELINE.length);
    const later = planSegment(world, TIMELINE, ENDLESS_CURVE, TIMELINE.length + 10);

    expect(first.hpMul).toBe(1);
    expect(later.hpMul).toBeGreaterThan(first.hpMul);
    expect(later.damageMul).toBeGreaterThan(first.damageMul);
    expect(later.maxAlive).toBe(ENDLESS_CURVE.maxAlive);
  });

  it("расширяет пул типов со временем и держит смесь разных паттернов", () => {
    const world = makeWorld();
    const late = planSegment(world, TIMELINE, ENDLESS_CURVE, TIMELINE.length + 20);

    expect(late.spawns.length).toBe(ENDLESS_CURVE.mixSize);
    const patterns = new Set(late.spawns.map((spawn) => world.enemyTypes[spawn.typeIndex].pattern));
    // Три врага одного поведения — это один враг втроём: реагировать не на что.
    expect(patterns.size).toBe(ENDLESS_CURVE.mixSize);
  });

  it("выдаёт отрезки одинаковой длины и в правильные секунды", () => {
    const lastManual = TIMELINE[TIMELINE.length - 1].fromSec;
    expect(segmentStartSec(TIMELINE, ENDLESS_CURVE, TIMELINE.length - 1)).toBe(lastManual);
    expect(segmentStartSec(TIMELINE, ENDLESS_CURVE, TIMELINE.length)).toBe(ENDLESS_CURVE.fromSec);
    expect(segmentStartSec(TIMELINE, ENDLESS_CURVE, TIMELINE.length + 2)).toBe(
      ENDLESS_CURVE.fromSec + ENDLESS_CURVE.segmentSec * 2,
    );
  });
});

describe("события отрезка", () => {
  const ringTimeline: TimelineSegmentDef[] = [
    { fromSec: 0, spawns: [], events: [{ kind: "ring", enemy: "swarm_rat", count: 16 }] },
  ];
  const flankTimeline: TimelineSegmentDef[] = [
    { fromSec: 0, spawns: [], events: [{ kind: "flank", enemy: "swarm_rat", count: 16 }] },
  ];
  const curve: EndlessCurveDef = { ...ENDLESS_CURVE, fromSec: 10_000 };

  function directions(timeline: TimelineSegmentDef[]): { x: number; y: number }[] {
    const world = makeWorld();
    createTimelineDirector(timeline, curve).update(world, 1 / 60);

    const result: { x: number; y: number }[] = [];
    for (let i = 0; i < world.enemies.count; i++) {
      if (world.enemies.alive[i] === 0) continue;
      const dx = world.enemies.x[i] - world.player.x;
      const dy = world.enemies.y[i] - world.player.y;
      const length = Math.hypot(dx, dy);
      expect(length).toBeGreaterThanOrEqual(world.config.view.spawnRadius);
      result.push({ x: dx / length, y: dy / length });
    }
    return result;
  }

  it("окружает игрока кольцом со всех сторон", () => {
    const ring = directions(ringTimeline);
    expect(ring).toHaveLength(16);

    // Кольцо — это враги во всех четвертях, а не куча с одной стороны.
    const quadrants = new Set(ring.map((d) => `${d.x >= 0 ? 1 : 0}${d.y >= 0 ? 1 : 0}`));
    expect(quadrants.size).toBe(4);
  });

  it("выбрасывает рой с одной стороны, а не вокруг", () => {
    const flank = directions(flankTimeline);
    expect(flank).toHaveLength(16);

    let meanX = 0;
    let meanY = 0;
    for (const d of flank) {
      meanX += d.x;
      meanY += d.y;
    }
    const length = Math.hypot(meanX, meanY);
    // Все направления в узкой дуге: их сумма почти равна их числу по длине.
    expect(length / flank.length).toBeGreaterThan(0.9);
  });
});

describe("проверка контента таймлайна", () => {
  it("ловит убывающий бюджет угрозы", () => {
    const timeline: TimelineSegmentDef[] = [
      { fromSec: 0, spawns: [{ enemy: "swarm_rat", perSec: 3 }] },
      { fromSec: 30, spawns: [{ enemy: "swarm_rat", perSec: 1 }] },
    ];
    expect(findTimelineProblems(timeline, ENDLESS_CURVE, ENEMIES).join("\n")).toMatch(
      /бюджет угрозы упал/,
    );
  });

  it("ловит элиту в обычном потоке и в пуле кривой", () => {
    const timeline: TimelineSegmentDef[] = [
      { fromSec: 0, spawns: [{ enemy: "elite_ghoul", perSec: 1 }] },
    ];
    const curve = { ...ENDLESS_CURVE, pool: [...ENDLESS_CURVE.pool, "elite_ghoul"] };
    const problems = findTimelineProblems(timeline, curve, ENEMIES).join("\n");

    expect(problems).toMatch(/элита elite_ghoul приходит только событием/);
    expect(problems).toMatch(/элита elite_ghoul не входит в обычную смесь/);
  });

  it("ловит несуществующего врага и отрезок, который ничего не делает", () => {
    const timeline: TimelineSegmentDef[] = [
      { fromSec: 0, spawns: [{ enemy: "ghost", perSec: 1 }] },
      { fromSec: 30, spawns: [] },
    ];
    const problems = findTimelineProblems(timeline, ENDLESS_CURVE, ENEMIES).join("\n");

    expect(problems).toMatch(/врага ghost нет в контенте/);
    expect(problems).toMatch(/нет ни спавна, ни события/);
  });

  it("не даёт кривой начаться раньше последнего ручного отрезка", () => {
    const curve = { ...ENDLESS_CURVE, fromSec: 10 };
    expect(findTimelineProblems(TIMELINE, curve, ENEMIES).join("\n")).toMatch(/fromSec/);
  });
});
