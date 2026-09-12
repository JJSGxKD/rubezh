import type {
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
  const eliteIds = new Set(enemies.filter((def) => def.elite === true).map((def) => def.id));

  const problems = [
    ...findSegmentProblems(timeline, threatById, eliteIds),
    ...findCurveProblems(curve, timeline, threatById, eliteIds),
  ];
  problems.push(...findThreatProblems(timeline, curve, threatById));
  return problems;
}

function findSegmentProblems(
  timeline: readonly TimelineSegmentDef[],
  threatById: ReadonlyMap<string, number>,
  eliteIds: ReadonlySet<string>,
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

    problems.push(...findEventProblems(segment.events ?? [], where, threatById));
  }
  return problems;
}

function findEventProblems(
  events: readonly TimelineEventDef[],
  where: string,
  threatById: ReadonlyMap<string, number>,
): string[] {
  const problems: string[] = [];
  for (const event of events) {
    if (!threatById.has(event.enemy)) {
      problems.push(`${where}: в событии ${event.kind} нет врага ${event.enemy}`);
    }
    if (!Number.isInteger(event.count) || event.count < 1) {
      problems.push(`${where}: count в событии ${event.kind} — целое, не меньше единицы`);
    }
  }
  return problems;
}

function findCurveProblems(
  curve: EndlessCurveDef,
  timeline: readonly TimelineSegmentDef[],
  threatById: ReadonlyMap<string, number>,
  eliteIds: ReadonlySet<string>,
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
  problems.push(...findEventProblems(curve.events, "кривая", threatById));
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
