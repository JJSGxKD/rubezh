import type { EndlessCurveDef, TimelineSegmentDef } from "@bh/shared-types";
import {
  createDirection,
  directionInArc,
  randomDirection,
  randomRingOffset,
  ringDirection,
} from "./directions";
import { spawnOnRing, spawnRandomOnRing, type Spawner } from "./spawner";
import { planSegment, segmentStartSec, type SegmentEvent, type SegmentPlan } from "./timeline";
import type { World } from "./world";

/**
 * Директор спавна: непрерывный поток врагов по таймлайну, а не волны с
 * паузами (docs/26-stage2-plan.md, WP4.4).
 *
 * Отрезок задаёт состав, темп и потолок живых; когда расписанные руками
 * отрезки кончаются, таймлайн продолжается по кривой бесконечного режима.
 * Расчёт отрезка — в timeline.ts, здесь только время и спавн.
 */

/** Раствор дуги роя с одной стороны: синус половины угла, примерно ±20°. */
const FLANK_ARC_SIN = 0.35;

/**
 * Сколько отрезков разрешено пройти за один тик. Страховка от данных, в
 * которых отрезок нулевой длины: цикл «догнать таймлайн» не имеет права
 * превратиться в бесконечный внутри кадра.
 */
const MAX_SEGMENT_STEPS_PER_TICK = 4;

const direction = createDirection();
const flankBase = createDirection();

export function createTimelineDirector(
  timeline: readonly TimelineSegmentDef[],
  curve: EndlessCurveDef,
): Spawner {
  let plan: SegmentPlan | null = null;
  let index = -1;
  /** долг спавна по каждой строке отрезка: дробные врагов в секунду копятся */
  let debt: number[] = [];

  function enterSegment(world: World, next: number): void {
    index = next;
    plan = planSegment(world, timeline, curve, next);
    // Аллокация раз в отрезок, то есть примерно раз в минуту: в кадре её нет,
    // а держать массив по максимальной длине смеси — лишняя сложность.
    debt = new Array<number>(plan.spawns.length).fill(0);

    world.difficulty.segment = plan.index;
    world.difficulty.segmentStartedSec = world.stats.elapsedSec;
    world.difficulty.hpMul = plan.hpMul;
    world.difficulty.damageMul = plan.damageMul;
    world.difficulty.maxAlive = plan.maxAlive;

    for (const burst of plan.bursts) {
      for (let n = 0; n < burst.count; n++) {
        if (atCap(world)) break;
        spawnRandomOnRing(world, burst.typeIndex);
      }
    }
    for (const event of plan.events) applyEvent(world, event);
  }

  return {
    update(world, dtSec) {
      let steps = 0;
      while (
        steps++ < MAX_SEGMENT_STEPS_PER_TICK &&
        world.stats.elapsedSec >= segmentStartSec(timeline, curve, index + 1)
      ) {
        enterSegment(world, index + 1);
      }
      if (plan === null) return;

      for (let i = 0; i < plan.spawns.length; i++) {
        const spawn = plan.spawns[i];
        debt[i] += spawn.perSec * dtSec;

        while (debt[i] >= 1) {
          if (atCap(world)) {
            // Долг обнуляется, а не копится: иначе после расчистки поля
            // накопленное за минуту у потолка выстреливает залпом, которого
            // кривая сложности не предусматривала.
            debt[i] = 0;
            break;
          }
          debt[i] -= 1;
          if (spawnRandomOnRing(world, spawn.typeIndex) < 0) {
            debt[i] = 0;
            break;
          }
        }
      }
    },
  };
}

function atCap(world: World): boolean {
  return world.enemies.aliveCount >= world.difficulty.maxAlive;
}

/**
 * События отрезка: окружение кольцом и рой с одной стороны. И то, и другое
 * появляется за пределами видимой области и считается тем же потолком живых —
 * запас производительности не отменяется красивой задумкой.
 */
function applyEvent(world: World, event: SegmentEvent): void {
  if (event.kind === "ring") {
    const offset = randomRingOffset(world.rng);
    for (let k = 0; k < event.count; k++) {
      if (atCap(world)) return;
      ringDirection(offset, k, event.count, direction);
      spawnOnRing(world, event.typeIndex, direction.x, direction.y);
    }
    return;
  }

  randomDirection(world.rng, flankBase);
  for (let k = 0; k < event.count; k++) {
    if (atCap(world)) return;
    directionInArc(world.rng, flankBase.x, flankBase.y, FLANK_ARC_SIN, direction);
    spawnOnRing(world, event.typeIndex, direction.x, direction.y);
  }
}
