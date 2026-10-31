import type { MapDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { MAPS } from "../src/content/maps";
import { CORDON_FORM_SEC, CORDON_PHASE } from "../src/game/patterns";
import { checksumWorld } from "../src/game/sim/checksum";
import { vectorLength } from "../src/game/sim/vector";
import { advanceRun, aliveGuards, CORDON_RING, createCordonRun, stepRun, type CordonRun } from "./helpers/scripted-run";

// Строй сразу (docs/35-stage4-plan.md Р166, tasks/T-0335): стражи появляются на
// радиусе кольца со вспышкой-телеграфом, а не идут с края экрана. Пока вспышка
// не погасла, страж не бьёт и не толкает.

const GUARD_RADIUS = 14;
const PLAYER_RADIUS = 10;

function fromCenter(run: CordonRun, index: number): number {
  return vectorLength(run.world.enemies.x[index] - run.world.cordon.centerX, run.world.enemies.y[index] - run.world.cordon.centerY);
}

describe("строй встаёт сразу", () => {
  it("после одного шага все сорок стражей на радиусе кольца, а не на радиусе спавна", () => {
    const run = createCordonRun();
    stepRun(run);
    const guards = aliveGuards(run.world);

    expect(guards).toHaveLength(40);
    expect(run.world.config.view.spawnRadius).toBeGreaterThan(CORDON_RING.radius + 100);
    for (const index of guards) expect(Math.abs(fromCenter(run, index) - CORDON_RING.radius)).toBeLessThanOrEqual(1);
  });

  it("сразу после старта фаза «формируется», таймер около CORDON_FORM_SEC", () => {
    const run = createCordonRun();
    stepRun(run);
    for (const index of aliveGuards(run.world)) {
      expect(run.world.enemies.phase[index]).toBe(CORDON_PHASE.forming);
      expect(Math.abs(run.world.enemies.phaseTimer[index] - CORDON_FORM_SEC)).toBeLessThanOrEqual(0.05);
    }
  });

  it("через CORDON_FORM_SEC + 0,1 с все сорок держат место", () => {
    const run = createCordonRun();
    advanceRun(run, CORDON_FORM_SEC + 0.1);
    const guards = aliveGuards(run.world);

    expect(guards).toHaveLength(40);
    for (const index of guards) expect(run.world.enemies.phase[index]).toBe(CORDON_PHASE.holding);
  });

  it("строй ровный: расстояния от центра у всех стражей совпадают до единицы", () => {
    const run = createCordonRun();
    stepRun(run);
    const distances = aliveGuards(run.world).map((index) => fromCenter(run, index));
    expect(Math.max(...distances) - Math.min(...distances)).toBeLessThanOrEqual(1);
  });
});

describe("формирующийся страж не бьёт и не толкает", () => {
  /** Игрок встаёт ровно на место одного из стражей, пока тот только появился. */
  function playerOnGuard(): { run: CordonRun; guard: number } {
    const run = createCordonRun({ playerHp: 100 });
    stepRun(run);
    const [guard] = aliveGuards(run.world);
    if (guard === undefined) throw new Error("нет стража");
    run.world.player.x = run.world.enemies.x[guard];
    run.world.player.y = run.world.enemies.y[guard];
    return { run, guard };
  }

  it("пока горит вспышка, игрок не выталкивается и не получает урон", () => {
    const { run, guard } = playerOnGuard();
    const start = [run.world.player.x, run.world.player.y];

    advanceRun(run, CORDON_FORM_SEC - 0.2);

    expect(run.world.enemies.phase[guard]).toBe(CORDON_PHASE.forming);
    expect([run.world.player.x, run.world.player.y]).toEqual(start);
    expect(run.world.player.hp).toBe(100);
  });

  it("после вспышки страж уже держит место, и выталкивание работает", () => {
    const { run, guard } = playerOnGuard();

    advanceRun(run, CORDON_FORM_SEC + 0.1);

    expect(run.world.enemies.phase[guard]).toBe(CORDON_PHASE.holding);
    const distance = vectorLength(run.world.player.x - run.world.enemies.x[guard], run.world.player.y - run.world.enemies.y[guard]);
    expect(distance).toBeGreaterThanOrEqual(GUARD_RADIUS + PLAYER_RADIUS - 1);
  });
});

describe("заморозка и границы карты", () => {
  it("замороженный на старте страж остаётся «формируется», пока заморожен", () => {
    const run = createCordonRun();
    stepRun(run);
    const [frozen, free] = aliveGuards(run.world);
    if (frozen === undefined || free === undefined) throw new Error("нет стражей");
    run.world.enemies.frozenTimer[frozen] = 5;

    advanceRun(run, CORDON_FORM_SEC + 0.3);

    expect(run.world.enemies.phase[frozen]).toBe(CORDON_PHASE.forming);
    expect(run.world.enemies.phase[free]).toBe(CORDON_PHASE.holding);
  });

  it("карта с границей и игрок у стены: ни NaN, все стражи внутри карты", () => {
    const bounded: MapDef = { ...(MAPS[0] as MapDef), bounds: { halfWidth: 1800 } };
    const run = createCordonRun({ map: bounded });
    run.world.player.x = 1750;
    advanceRun(run, 1);

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
  const sum = (seed: number) => {
    const run = createCordonRun({ seed });
    advanceRun(run, 1);
    return checksumWorld(run.world);
  };

  it("один seed — одна контрольная сумма, другой seed — другая", () => {
    expect(sum(9)).toBe(sum(9));
    expect(sum(9)).not.toBe(sum(10));
  });
});
