import type {
  CordonInnerDef,
  CordonRingDef,
  EndlessCurveDef,
  EnemyDef,
  TimelineEventDef,
  TimelineSegmentDef,
} from "@bh/shared-types";
import { defaultThreat } from "../patterns/enemy-types";

/**
 * Проверка таймлайна спавна — отдельным файлом от расчёта отрезков
 * (timeline.ts): там горячий путь забега, здесь разбор данных, которые пришли
 * из контента, а позже придут из админки JSON-ом (docs/19-content-admin.md).
 *
 * Сообщения читает геймдизайнер в выводе CI, поэтому они называют отрезок,
 * поле и то, что с ним не так, — а не «invalid timeline».
 */
export function findTimelineProblems(
  timeline: readonly TimelineSegmentDef[],
  curve: EndlessCurveDef,
  enemies: readonly EnemyDef[],
): string[] {
  const threatById = new Map(enemies.map((def) => [def.id, def.threat ?? defaultThreat(def)]));
  const eliteIds = new Set(enemies.filter((def) => def.rank !== undefined).map((def) => def.id));
  const enemyById = new Map(enemies.map((def) => [def.id, def]));

  const problems = [
    ...findSegmentProblems(timeline, threatById, eliteIds, enemyById),
    ...findCurveProblems(curve, timeline, threatById, eliteIds, enemyById),
  ];
  problems.push(...findThreatProblems(timeline, curve, threatById));
  return problems;
}

function findSegmentProblems(
  timeline: readonly TimelineSegmentDef[],
  threatById: ReadonlyMap<string, number>,
  eliteIds: ReadonlySet<string>,
  enemyById: ReadonlyMap<string, EnemyDef>,
): string[] {
  const problems: string[] = [];
  if (timeline.length === 0) return ["таймлайн пуст: забегу не с чего начинаться"];
  if (timeline[0].fromSec !== 0) {
    problems.push("таймлайн: первый отрезок обязан начинаться с нулевой секунды");
  }

  for (let i = 0; i < timeline.length; i++) {
    const segment = timeline[i];
    const where = `отрезок на ${segment.fromSec}s`;

    if (i > 0 && segment.fromSec <= timeline[i - 1].fromSec) {
      problems.push(`${where}: секунды отрезков должны строго возрастать`);
    }
    if (segment.maxAlive !== undefined && !(segment.maxAlive >= 1)) {
      problems.push(`${where}: maxAlive должен быть не меньше единицы`);
    }
    if (segment.spawns.length === 0 && (segment.events ?? []).length === 0) {
      problems.push(`${where}: нет ни спавна, ни события — отрезок ничего не делает`);
    }

    for (const spawn of segment.spawns) {
      if (!threatById.has(spawn.enemy)) {
        problems.push(`${where}: врага ${spawn.enemy} нет в контенте`);
        continue;
      }
      if (eliteIds.has(spawn.enemy)) {
        // Элита обязана приходить в назначенную минуту, а не сочиться потоком:
        // контрольная точка сложности перестаёт быть контрольной точкой.
        problems.push(`${where}: элита ${spawn.enemy} приходит только событием`);
      }
      if (enemyById.get(spawn.enemy)?.pattern === "cordon") {
        problems.push(`${where}: страж ${spawn.enemy} приходит только событием cordon`);
      }
      if (spawn.perSec !== undefined && !(spawn.perSec > 0)) {
        problems.push(`${where}: perSec у ${spawn.enemy} должен быть больше нуля`);
      }
      if (spawn.burst !== undefined && (!Number.isInteger(spawn.burst) || spawn.burst < 1)) {
        problems.push(`${where}: burst у ${spawn.enemy} — целое, не меньше единицы`);
      }
      if (spawn.perSec === undefined && spawn.burst === undefined) {
        problems.push(`${where}: у ${spawn.enemy} не задано ни perSec, ни burst`);
      }
    }

    problems.push(...findEventProblems(segment.events ?? [], where, threatById, enemyById));
  }
  return problems;
}

function findEventProblems(
  events: readonly TimelineEventDef[],
  where: string,
  threatById: ReadonlyMap<string, number>,
  enemyById: ReadonlyMap<string, EnemyDef>,
): string[] {
  const problems: string[] = [];
  for (const event of events) {
    if (!threatById.has(event.enemy)) {
      problems.push(`${where}: в событии ${event.kind} нет врага ${event.enemy}`);
    }
    const guard = enemyById.get(event.enemy)?.pattern === "cordon";
    if (event.kind === "cordon") {
      if (event.ring === undefined) problems.push(`${where}: у события cordon нет ring`);
      if (!Number.isInteger(event.count) || event.count < 1 || event.count > CORDON_MAX_COUNT) {
        problems.push(`${where}: count в событии cordon — целое от 1 до ${CORDON_MAX_COUNT}`);
      }
      if (enemyById.has(event.enemy) && !guard) {
        problems.push(`${where}: враг ${event.enemy} в событии cordon — не паттерна cordon`);
      }
      if (event.ring !== undefined) problems.push(...findRingProblems(event.ring, where, enemyById.get(event.enemy), enemyById));
      continue;
    }
    if (event.ring !== undefined) problems.push(`${where}: ring задаётся только у события cordon, а не ${event.kind}`);
    if (guard) problems.push(`${where}: страж ${event.enemy} в событии ${event.kind}: он приходит только кольцом cordon`);
    if (!Number.isInteger(event.count) || event.count < 1) {
      problems.push(`${where}: count в событии ${event.kind} — целое, не меньше единицы`);
    }
  }
  return problems;
}

/*
 * Границы кольца стартовые — калибрует геймдизайнер. Их держит смысл механики:
 * стражи приходят снаружи экрана (radius меньше кольца спавна), а строй не
 * сжимается до тесноты, в которой игрока раздавит стенка.
 */
const CORDON_MAX_COUNT = 64;
const CORDON_MAX_RADIUS = 420;
const CORDON_MIN_RADIUS_FLOOR = 60;
const CORDON_LIFE_SEC = { min: 5, max: 120 } as const;

function findRingProblems(ring: CordonRingDef, where: string, guard: EnemyDef | undefined, enemyById: ReadonlyMap<string, EnemyDef>): string[] {
  const problems: string[] = [];
  if (!(ring.minRadius >= CORDON_MIN_RADIUS_FLOOR)) {
    problems.push(`${where}: ring.minRadius — не меньше ${CORDON_MIN_RADIUS_FLOOR}: теснее строй раздавит игрока`);
  }
  if (!(ring.radius <= CORDON_MAX_RADIUS)) {
    problems.push(`${where}: ring.radius — не больше ${CORDON_MAX_RADIUS}: строй должен целиком помещаться в карту`);
  }
  if (!(ring.minRadius < ring.radius)) problems.push(`${where}: ring.minRadius должен быть меньше ring.radius`);
  if (!(ring.shrinkPerSec > 0)) problems.push(`${where}: ring.shrinkPerSec должен быть больше нуля`);
  else if (guard !== undefined && ring.shrinkPerSec > guard.speed) {
    problems.push(`${where}: ring.shrinkPerSec не больше скорости стража (${guard.speed}): быстрее строй не удержать`);
  }
  if (!(ring.lifeSec >= CORDON_LIFE_SEC.min && ring.lifeSec <= CORDON_LIFE_SEC.max)) {
    problems.push(`${where}: ring.lifeSec — от ${CORDON_LIFE_SEC.min} до ${CORDON_LIFE_SEC.max} секунд`);
  }
  if (ring.inner !== undefined) problems.push(...findInnerProblems(ring.inner, where, enemyById));
  return problems;
}

/** Внутренних врагов кольца: записей, штук в записи и всего на кольцо. */
const INNER_MAX_ENTRIES = 4;
const INNER_MAX_COUNT = 4;
const INNER_MAX_TOTAL = 6;

function findInnerProblems(inner: readonly CordonInnerDef[], where: string, enemyById: ReadonlyMap<string, EnemyDef>): string[] {
  const problems: string[] = [];
  if (!Array.isArray(inner) || inner.length < 1 || inner.length > INNER_MAX_ENTRIES) {
    return [`${where}: ring.inner — от 1 до ${INNER_MAX_ENTRIES} записей, а не пустой и не длиннее`];
  }

  let total = 0;
  inner.forEach((entry, index) => {
    const at = `${where}: ring.inner[${index}]`;
    const def = enemyById.get(entry.enemy);
    if (def === undefined) problems.push(`${at} — врага ${entry.enemy} нет в контенте`);
    else if (def.rank !== "elite" && def.rank !== "boss") problems.push(`${at} — враг ${entry.enemy} не элита и не босс`);
    else if (def.pattern === "cordon") problems.push(`${at} — страж ${entry.enemy} не может быть внутри строя`);
    if (!Number.isInteger(entry.count) || entry.count < 1 || entry.count > INNER_MAX_COUNT) {
      problems.push(`${at}: count — целое от 1 до ${INNER_MAX_COUNT}`);
    } else {
      total += entry.count;
    }
    if (entry.fromSec !== undefined && !(entry.fromSec >= 0)) problems.push(`${at}: fromSec — число не меньше 0`);
  });
  if (total > INNER_MAX_TOTAL) problems.push(`${where}: ring.inner — всего внутренних не больше ${INNER_MAX_TOTAL}, а записано ${total}`);
  return problems;
}

function findCurveProblems(
  curve: EndlessCurveDef,
  timeline: readonly TimelineSegmentDef[],
  threatById: ReadonlyMap<string, number>,
  eliteIds: ReadonlySet<string>,
  enemyById: ReadonlyMap<string, EnemyDef>,
): string[] {
  const problems: string[] = [];
  const lastManual = timeline.length === 0 ? -1 : timeline[timeline.length - 1].fromSec;

  if (!(curve.fromSec > lastManual)) {
    problems.push(
      `кривая: fromSec должен быть больше последнего расписанного руками отрезка (${lastManual}s)`,
    );
  }
  if (!(curve.segmentSec > 0)) problems.push("кривая: segmentSec должен быть больше нуля");
  if (!(curve.threatPerSec > 0)) problems.push("кривая: threatPerSec должен быть больше нуля");
  if (!(curve.maxAlive >= 1)) problems.push("кривая: maxAlive должен быть не меньше единицы");

  // Убывающий множитель — это не «другой баланс», а бесконечный режим, который
  // со временем становится легче: забег перестаёт кончаться вовсе.
  for (const key of ["threatGrowth", "hpGrowth", "damageGrowth"] as const) {
    if (!(curve[key] >= 1)) problems.push(`кривая: ${key} не может быть меньше единицы`);
  }

  if (curve.pool.length === 0) problems.push("кривая: пул типов пуст");
  for (const id of curve.pool) {
    if (!threatById.has(id)) problems.push(`кривая: врага ${id} нет в контенте`);
    else if (eliteIds.has(id)) problems.push(`кривая: элита ${id} не входит в обычную смесь`);
    else if (enemyById.get(id)?.pattern === "cordon") problems.push(`кривая: страж ${id} не входит в обычную смесь: он приходит только кольцом`);
  }

  if (!(curve.startTypes >= 1)) problems.push("кривая: startTypes должен быть не меньше единицы");
  if (!(curve.typesPerSegment >= 0)) {
    problems.push("кривая: typesPerSegment не может быть отрицательным");
  }
  if (!(curve.mixSize >= 1)) problems.push("кривая: mixSize должен быть не меньше единицы");
  if (curve.mixSize > curve.startTypes) {
    problems.push("кривая: mixSize больше startTypes — на первом отрезке смесь не наберётся");
  }

  for (const event of curve.events) {
    if (!Number.isInteger(event.everySegments) || event.everySegments < 1) {
      problems.push(`кривая: everySegments в событии ${event.kind} — целое, не меньше единицы`);
    }
  }
  problems.push(...findEventProblems(curve.events, "кривая", threatById, enemyById));
  return problems;
}

/**
 * Бюджет угрозы не убывает — свойство баланса, которое переживает любые числа
 * (docs/17-testing-strategy.md §3.3). Считается только непрерывный поток:
 * разовый выброс в начале отрезка к темпу отношения не имеет.
 */
function findThreatProblems(
  timeline: readonly TimelineSegmentDef[],
  curve: EndlessCurveDef,
  threatById: ReadonlyMap<string, number>,
): string[] {
  const problems: string[] = [];
  let previous = 0;

  for (const segment of timeline) {
    let threatPerSec = 0;
    for (const spawn of segment.spawns) {
      threatPerSec += (spawn.perSec ?? 0) * (threatById.get(spawn.enemy) ?? 0);
    }
    if (threatPerSec < previous) {
      problems.push(
        `отрезок на ${segment.fromSec}s: бюджет угрозы упал с ${round(previous)} до ${round(threatPerSec)} в секунду`,
      );
    }
    previous = Math.max(previous, threatPerSec);
  }

  if (curve.threatPerSec < previous) {
    problems.push(
      `кривая: threatPerSec ${round(curve.threatPerSec)} ниже последнего ручного отрезка (${round(previous)})`,
    );
  }
  return problems;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
