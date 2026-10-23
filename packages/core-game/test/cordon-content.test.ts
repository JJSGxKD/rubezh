import type { CordonRingDef, EndlessCurveDef, EnemyDef, TimelineEventDef, TimelineSegmentDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENDLESS_CURVE } from "../src/content/waves";
import { findTimelineProblems } from "../src/game/sim/timeline-content";
import { CORDON_RING, GUARD, RAT } from "./helpers/scripted-run";

// Проверка таймлайна для кольца (tasks/T-0170, шаг 7): сообщения называют
// отрезок и поле, потому что читает их геймдизайнер в выводе CI.

const ENEMIES: EnemyDef[] = [GUARD, RAT];
const CURVE: EndlessCurveDef = { ...ENDLESS_CURVE, pool: ["rat"], startTypes: 1, mixSize: 1, events: [] };

const event = (patch: Partial<TimelineEventDef> = {}, ring: Partial<CordonRingDef> | null = {}): TimelineEventDef => ({
  kind: "cordon",
  enemy: "guard",
  count: 40,
  ...(ring === null ? {} : { ring: { ...CORDON_RING, ...ring } }),
  ...patch,
});

/** Таймлайн с одним событием на шестидесятой секунде. */
const timeline = (...events: TimelineEventDef[]): TimelineSegmentDef[] => [
  { fromSec: 0, spawns: [{ enemy: "rat", perSec: 1 }] },
  { fromSec: 60, spawns: [{ enemy: "rat", perSec: 1 }], events },
];

const problems = (...events: TimelineEventDef[]) => findTimelineProblems(timeline(...events), CURVE, ENEMIES);

describe("кольцо в таймлайне", () => {
  it("годное событие — без замечаний", () => {
    expect(problems(event())).toEqual([]);
  });

  it("без ring и ring у чужого вида", () => {
    expect(problems(event({}, null))).toContainEqual(expect.stringMatching(/отрезок на 60s:.*cordon.*ring/));
    expect(problems({ kind: "flank", enemy: "rat", count: 5, ring: CORDON_RING })).toContainEqual(expect.stringMatching(/отрезок на 60s:.*ring.*flank/));
  });

  it("враг события cordon — не паттерна cordon", () => {
    expect(problems(event({ enemy: "rat" }))).toContainEqual(expect.stringMatching(/отрезок на 60s:.*rat.*cordon/));
  });

  it("страж приходит только кольцом: не потоком, не смесью кривой и не другим событием", () => {
    const inSpawns: TimelineSegmentDef[] = [{ fromSec: 0, spawns: [{ enemy: "guard", perSec: 1 }] }];
    expect(findTimelineProblems(inSpawns, CURVE, ENEMIES)).toContainEqual(expect.stringMatching(/отрезок на 0s:.*guard.*cordon/));
    expect(findTimelineProblems(timeline(event()), { ...CURVE, pool: ["rat", "guard"] }, ENEMIES)).toContainEqual(expect.stringMatching(/кривая:.*guard/));
    expect(problems({ kind: "ring", enemy: "guard", count: 5 })).toContainEqual(expect.stringMatching(/отрезок на 60s:.*guard.*ring/));
  });

  it("count — целое от 1 до 64", () => {
    for (const count of [0, 65, 2.5]) expect(problems(event({ count })), String(count)).toContainEqual(expect.stringMatching(/отрезок на 60s:.*count.*1 до 64/));
    for (const count of [1, 64]) expect(problems(event({ count })), String(count)).toEqual([]);
  });

  it("minRadius не меньше 60", () => {
    expect(problems(event({}, { minRadius: 59 }))).toContainEqual(expect.stringMatching(/отрезок на 60s:.*minRadius.*60/));
    expect(problems(event({}, { minRadius: 60 }))).toEqual([]);
  });

  it("radius не больше 420", () => {
    expect(problems(event({}, { radius: 421 }))).toContainEqual(expect.stringMatching(/отрезок на 60s:.*radius.*420/));
    expect(problems(event({}, { radius: 420 }))).toEqual([]);
  });

  it("minRadius строго меньше radius", () => {
    expect(problems(event({}, { radius: 100, minRadius: 100 }))).toContainEqual(expect.stringMatching(/отрезок на 60s:.*minRadius.*radius/));
    expect(problems(event({}, { radius: 100, minRadius: 120 }))).toContainEqual(expect.stringMatching(/отрезок на 60s:.*minRadius.*radius/));
  });

  it("shrinkPerSec больше нуля и не больше скорости стража", () => {
    expect(problems(event({}, { shrinkPerSec: 0 }))).toContainEqual(expect.stringMatching(/отрезок на 60s:.*shrinkPerSec/));
    expect(problems(event({}, { shrinkPerSec: 41 }))).toContainEqual(expect.stringMatching(/отрезок на 60s:.*shrinkPerSec.*40/));
    expect(problems(event({}, { shrinkPerSec: 40 }))).toEqual([]);
  });

  it("lifeSec от 5 до 120", () => {
    for (const lifeSec of [4, 121]) expect(problems(event({}, { lifeSec })), String(lifeSec)).toContainEqual(expect.stringMatching(/отрезок на 60s:.*lifeSec.*5 до 120/));
    for (const lifeSec of [5, 120]) expect(problems(event({}, { lifeSec })), String(lifeSec)).toEqual([]);
  });

  it("событие кривой проверяется так же, как в расписанном отрезке", () => {
    const curve: EndlessCurveDef = { ...CURVE, events: [{ everySegments: 2, kind: "cordon", enemy: "guard", count: 40, ring: { ...CORDON_RING, lifeSec: 4 } }] };
    expect(findTimelineProblems(timeline(), curve, ENEMIES)).toContainEqual(expect.stringMatching(/кривая:.*lifeSec/));
  });
});
