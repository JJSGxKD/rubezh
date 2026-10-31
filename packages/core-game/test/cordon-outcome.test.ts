import { describe, expect, it } from "vitest";
import { damageEnemy } from "../src/game/sim/combat";
import { checksumWorld } from "../src/game/sim/checksum";
import { takeCordonEvents } from "../src/game/sim/cordon";
import { advanceRun, aliveGuards, CORDON_RING, createCordonRun, stepRun, type CordonRun } from "./helpers/scripted-run";

// Исход кольца для аналитики (tasks/T-0182, событие ring_ended): прорвался,
// выстоял до конца времени или погиб внутри. Одно событие на кольцо.

/** Убить всех живых стражей. */
function killGuards(run: CordonRun): void {
  for (const index of aliveGuards(run.world)) damageEnemy(run.world, index, 1e9, 0);
}

/** События с начала забега: курсор в нуле. */
function events(run: CordonRun) {
  return takeCordonEvents(run.world, 0).ended;
}

describe("исход кольца", () => {
  it("убиты все стражи — «прорвался», убитых столько же, сколько вышло", () => {
    const run = createCordonRun();
    advanceRun(run, 5);
    killGuards(run);
    stepRun(run);

    expect(run.world.cordon.active).toBe(false);
    const [ended, ...rest] = events(run);
    expect(rest).toEqual([]);
    expect(ended).toMatchObject({ index: 0, outcome: "broken", guards: 40, killed: 40 });
    expect(ended.lifeSec).toBeGreaterThan(4.9);
    expect(ended.lifeSec).toBeLessThan(5.2);
  });

  it("вышло время при живых стражах — «выстоял», стражи исчезли", () => {
    const run = createCordonRun();
    advanceRun(run, CORDON_RING.lifeSec + 1);
    // часть стражей убита заранее — killed считается к концу кольца
    expect(run.world.cordon.active).toBe(false);
    expect(aliveGuards(run.world)).toHaveLength(0);

    const [ended, ...rest] = events(run);
    expect(rest).toEqual([]);
    expect(ended).toMatchObject({ index: 0, outcome: "held", guards: 40, killed: 0 });
    expect(ended.lifeSec).toBeGreaterThanOrEqual(CORDON_RING.lifeSec - 0.1);
    expect(ended.lifeSec).toBeLessThan(CORDON_RING.lifeSec + 0.2);
  });

  it("убиты не все, потом вышло время — «выстоял», killed меньше guards", () => {
    const run = createCordonRun();
    advanceRun(run, 5);
    for (const index of aliveGuards(run.world).slice(0, 10)) damageEnemy(run.world, index, 1e9, 0);
    advanceRun(run, CORDON_RING.lifeSec);

    const [ended] = events(run);
    expect(ended).toMatchObject({ outcome: "held", guards: 40, killed: 10 });
  });

  it("игрок погиб при активном кольце — «погиб» в тот же тик, кольцо закрыто", () => {
    const run = createCordonRun();
    advanceRun(run, 5);
    expect(run.world.cordon.active).toBe(true);
    run.world.player.alive = false;
    stepRun(run);

    expect(run.world.cordon.active).toBe(false);
    const [ended, ...rest] = events(run);
    expect(rest).toEqual([]);
    expect(ended).toMatchObject({ index: 0, outcome: "died", guards: 40 });
  });

  it("на кольцо ровно одно событие, повторных шагов оно не плодит", () => {
    const run = createCordonRun();
    advanceRun(run, 5);
    run.world.player.alive = false;
    advanceRun(run, 3);
    expect(events(run)).toHaveLength(1);
  });

  it("два кольца подряд — index 0 и 1", () => {
    const run = createCordonRun({
      timeline: [
        { fromSec: 0, spawns: [], events: [{ kind: "cordon", enemy: "guard", count: 10, ring: CORDON_RING }] },
        { fromSec: 20, spawns: [], events: [{ kind: "cordon", enemy: "guard", count: 10, ring: CORDON_RING }] },
      ],
    });
    advanceRun(run, 3);
    killGuards(run);
    advanceRun(run, 25);
    killGuards(run);
    advanceRun(run, 1);

    const list = events(run);
    expect(list.map((item: { index: number }) => item.index)).toEqual([0, 1]);
  });

  it("курсор отдаёт только новые записи", () => {
    const run = createCordonRun();
    advanceRun(run, 3);
    killGuards(run);
    stepRun(run);

    const first = takeCordonEvents(run.world, 0);
    expect(first.ended).toHaveLength(1);
    expect(first.cursor).toBe(1);
    expect(takeCordonEvents(run.world, first.cursor).ended).toEqual([]);
  });

  it("забег кончился при активном кольце — события нет: исход не наступил", () => {
    const run = createCordonRun();
    advanceRun(run, 5);
    expect(run.world.cordon.active).toBe(true);
    expect(events(run)).toEqual([]);
  });

  it("поля журнала в контрольную сумму не входят", () => {
    const run = createCordonRun();
    advanceRun(run, 5);
    const before = checksumWorld(run.world);
    run.world.cordon.ended.push({ index: 9, outcome: "died", guards: 1, killed: 1, lifeSec: 1, elapsedSec: 1 });
    run.world.cordon.ringsStarted += 5;
    run.world.cordon.startedAtSec += 5;
    run.world.cordon.guards += 5;
    expect(checksumWorld(run.world)).toBe(before);
  });
});
