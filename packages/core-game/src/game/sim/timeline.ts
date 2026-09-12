import type { EndlessCurveDef, TimelineEventKind, TimelineSegmentDef } from "@bh/shared-types";
import type { World } from "./world";

/**
 * Таймлайн спавна: из чего состоит отрезок и как считается тот, которого нет
 * в контенте (docs/26-stage2-plan.md, WP4.4).
 *
 * Здесь только расчёт — что и с каким темпом должно появиться. Сам спавн и
 * счёт времени — в director.ts: так «сколько врагов положено» можно проверить
 * тестом, не гоняя симуляцию.
 */

export interface SegmentSpawn {
  typeIndex: number;
  /** врагов в секунду */
  perSec: number;
}

export interface SegmentBurst {
  typeIndex: number;
  count: number;
}

export interface SegmentEvent {
  kind: TimelineEventKind;
  typeIndex: number;
  count: number;
}

export interface SegmentPlan {
  index: number;
  fromSec: number;
  /** потолок живых врагов на этом отрезке */
  maxAlive: number;
  hpMul: number;
  damageMul: number;
  /** сколько угрозы в секунду выпускает отрезок — этим меряется сложность */
  threatPerSec: number;
  spawns: SegmentSpawn[];
  bursts: SegmentBurst[];
  events: SegmentEvent[];
}

/** Секунда, на которой начинается отрезок с таким номером. */
export function segmentStartSec(
  timeline: readonly TimelineSegmentDef[],
  curve: EndlessCurveDef,
  index: number,
): number {
  if (index < timeline.length) return timeline[index].fromSec;
  return curve.fromSec + (index - timeline.length) * curve.segmentSec;
}

/**
 * Степень умножением в цикле, а не через Math.pow: степень по спецификации
 * ECMAScript приближённая и расходится между JS-движками, а от неё зависит
 * бюджет отрезка, то есть исход забега (docs/26-stage2-plan.md, WP4.5).
 */
function power(base: number, exponent: number): number {
  let result = 1;
  for (let step = 0; step < exponent; step++) result *= base;
  return result;
}

/**
 * Что должно происходить на отрезке. Для расписанного руками отрезка это
 * пересказ контента, для генерируемого — расчёт по кривой: бюджет угрозы
 * растёт, пул типов расширяется, а состав каждый раз выбирается заново.
 */
export function planSegment(
  world: World,
  timeline: readonly TimelineSegmentDef[],
  curve: EndlessCurveDef,
  index: number,
): SegmentPlan {
  const fromSec = segmentStartSec(timeline, curve, index);
  return index < timeline.length
    ? planManualSegment(world, timeline[index], curve, index, fromSec)
    : planGeneratedSegment(world, curve, index, index - timeline.length, fromSec);
}

function planManualSegment(
  world: World,
  segment: TimelineSegmentDef,
  curve: EndlessCurveDef,
  index: number,
  fromSec: number,
): SegmentPlan {
  const spawns: SegmentSpawn[] = [];
  const bursts: SegmentBurst[] = [];
  let threatPerSec = 0;

  for (const spawn of segment.spawns) {
    const typeIndex = world.enemyTypes.findIndex((type) => type.id === spawn.enemy);
    if (typeIndex < 0) continue;

    const perSec = spawn.perSec ?? 0;
    if (perSec > 0) {
      spawns.push({ typeIndex, perSec });
      threatPerSec += perSec * world.enemyTypes[typeIndex].threat;
    }
    if (spawn.burst !== undefined && spawn.burst > 0) {
      bursts.push({ typeIndex, count: spawn.burst });
    }
  }

  return {
    index,
    fromSec,
    maxAlive: segment.maxAlive ?? curve.maxAlive,
    hpMul: 1,
    damageMul: 1,
    threatPerSec,
    spawns,
    bursts,
    events: resolveEvents(world, segment.events ?? []),
  };
}

/**
 * Сгенерированный отрезок. Бюджет угрозы растёт каждый отрезок, пул доступных
 * типов расширяется, а в дело идёт не один тип, а смесь: сложность обязана
 * расти комбинациями паттернов, иначе поздний забег — это один и тот же враг
 * во всё большем количестве (docs/05-game-design.md §4).
 */
function planGeneratedSegment(
  world: World,
  curve: EndlessCurveDef,
  index: number,
  step: number,
  fromSec: number,
): SegmentPlan {
  const unlocked = Math.min(
    curve.pool.length,
    Math.max(1, curve.startTypes + curve.typesPerSegment * step),
  );
  const candidates: number[] = [];
  for (let i = 0; i < unlocked; i++) {
    const typeIndex = world.enemyTypes.findIndex((type) => type.id === curve.pool[i]);
    if (typeIndex >= 0) candidates.push(typeIndex);
  }

  const mix = pickMix(world, candidates, Math.max(1, curve.mixSize));
  const budget = curve.threatPerSec * power(curve.threatGrowth, step);
  const share = mix.length === 0 ? 0 : budget / mix.length;

  const spawns: SegmentSpawn[] = mix.map((typeIndex) => ({
    typeIndex,
    perSec: share / world.enemyTypes[typeIndex].threat,
  }));

  // Бюджет расходуется целиком, поэтому заявленная угроза равна бюджету — но
  // только пока число живых не упёрлось в потолок. Дальше директор перестаёт
  // спавнить, и сложность растёт множителями здоровья и урона.
  return {
    index,
    fromSec,
    maxAlive: curve.maxAlive,
    hpMul: power(curve.hpGrowth, step),
    damageMul: power(curve.damageGrowth, step),
    threatPerSec: mix.length === 0 ? 0 : budget,
    spawns,
    bursts: [],
    events: resolveEvents(
      world,
      curve.events.filter((event) => (step + 1) % Math.max(1, event.everySegments) === 0),
    ),
  };
}

/**
 * Смесь типов на отрезок: сначала берутся типы с ещё не занятым паттерном.
 * Три врага одного поведения — это один враг втроём, и реагировать на такую
 * смесь игроку не на что.
 */
function pickMix(world: World, candidates: readonly number[], size: number): number[] {
  const pool = [...candidates];
  const picked: number[] = [];
  const patterns = new Set<string>();

  while (picked.length < size && pool.length > 0) {
    let index = world.rng.nextInt(0, pool.length);
    for (let probe = 0; probe < pool.length; probe++) {
      const candidate = (index + probe) % pool.length;
      if (patterns.has(world.enemyTypes[pool[candidate]].pattern)) continue;
      index = candidate;
      break;
    }
    picked.push(pool[index]);
    patterns.add(world.enemyTypes[pool[index]].pattern);
    pool.splice(index, 1);
  }
  return picked;
}

function resolveEvents(
  world: World,
  defs: readonly { kind: TimelineEventKind; enemy: string; count: number }[],
): SegmentEvent[] {
  const events: SegmentEvent[] = [];
  for (const def of defs) {
    const typeIndex = world.enemyTypes.findIndex((type) => type.id === def.enemy);
    if (typeIndex >= 0) events.push({ kind: def.kind, typeIndex, count: def.count });
  }
  return events;
}
