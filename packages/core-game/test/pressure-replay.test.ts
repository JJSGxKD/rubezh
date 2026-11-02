import type { RunLoadout } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CONTENT_HASH } from "../src/content/hash";
import { replayRecording } from "../src/game/diagnostics/replay";
import { chooseUpgrade, isAwaitingChoice } from "../src/game/progression/levels";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { buildRunResult } from "../src/game/run/run-result";
import { createRunWorld, type RunWorld } from "../src/game/run-world";
import { checksumWorld } from "../src/game/sim/checksum";
import { describePressureStart } from "../src/game/sim/pressure";
import { stepWorld, type SimInput } from "../src/game/sim/step";
import { TICK_SEC } from "../src/game/sim/world";
import { circling, recordHeadlessRun } from "./helpers/recorded-run";

// Повтор, снимок и итог забега с подстройкой (tasks/T-0195, критерии приёмки).
// Класс устройства едет внутри набора, поэтому запись и снимок его несут без
// единой правки формата записи.

const LONG_RUN = { timeout: 120_000 };

const LOADOUT: RunLoadout = { modifiers: { damage: 0.1, maxHp: 20 }, boosts: ["fury"], accountLevel: 8 };

describe("повтор забега с подстройкой", () => {
  it("слабое устройство: повтор по записи даёт тот же бой", LONG_RUN, () => {
    const recording = recordHeadlessRun({
      seed: 7,
      maxTicks: 24_000,
      difficultyId: "hard",
      steer: circling(200),
      loadout: { ...LOADOUT, deviceClass: "light" },
    });

    expect(recording.loadout?.deviceClass).toBe("light");
    expect(recording.loadout?.accountLevel).toBe(8);
    expect(replayRecording(recording).verdict).toBe("match");
  });

  it("обычное устройство: повтор даёт тот же бой, а в записи поля класса нет", LONG_RUN, () => {
    const recording = recordHeadlessRun({ seed: 7, maxTicks: 24_000, difficultyId: "hard", steer: circling(200), loadout: LOADOUT });

    expect(recording.loadout?.accountLevel).toBe(8);
    expect(recording.loadout !== undefined && "deviceClass" in recording.loadout).toBe(false);
    expect(replayRecording(recording).verdict).toBe("match");
  });
});

/** Ввод, зависящий только от тика: бот калибровки помнит прошлое, а это состояние теста, а не мира. */
const DIRECTIONS: readonly SimInput[] = [
  { moveX: 1, moveY: 0 },
  { moveX: 1, moveY: 1 },
  { moveX: 0, moveY: 1 },
  { moveX: -1, moveY: 1 },
  { moveX: -1, moveY: 0 },
  { moveX: -1, moveY: -1 },
  { moveX: 0, moveY: -1 },
  { moveX: 1, moveY: -1 },
];

function newRun(loadout: RunLoadout): RunWorld {
  return createRunWorld({ seed: 31, mapId: "", difficultyId: "hard", unitScale: 2, loadout });
}

function advance(run: RunWorld, seconds: number): void {
  for (let done = 0; done < seconds * 60 && run.world.player.alive; ) {
    if (isAwaitingChoice(run.world)) {
      const offers = run.world.progression.offers;
      chooseUpgrade(run.world, (offers[1] ?? offers[0]).id);
      continue;
    }
    run.spawner.update(run.world, TICK_SEC);
    stepWorld(run.world, DIRECTIONS[Math.floor(run.world.stats.tick / 90) % DIRECTIONS.length]);
    done++;
  }
}

describe("снимок забега с подстройкой", () => {
  it("посреди забега продолжается в тот же бой, а числа подстройки переезжают", LONG_RUN, () => {
    const loadout: RunLoadout = { ...LOADOUT, deviceClass: "light" };
    const continuous = newRun(loadout);
    advance(continuous, 200);

    const saved = JSON.parse(JSON.stringify(captureWorld(continuous.world, continuous.spawner))) as unknown;
    const resumed = newRun(loadout);
    restoreWorld(resumed.world, resumed.spawner, saved);
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(continuous.world));

    advance(continuous, 200);
    advance(resumed, 200);

    // Забег дошёл до отрезков с пересчётом: иначе проверка обходит числа, которые мир пересчитывает по ходу.
    expect(continuous.world.difficulty.segment).toBeGreaterThan(3);
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(continuous.world));
    expect(resumed.world.rng.getState()).toBe(continuous.world.rng.getState());
    expect(resumed.world.difficulty).toEqual(continuous.world.difficulty);
    for (const field of ["power", "pressureLevel", "startPower", "startPressure", "spawnMul", "stageShiftSec", "eliteLead", "bossLead"] as const) {
      expect(resumed.world.difficulty[field], field).toBe(continuous.world.difficulty[field]);
    }
  });
});

describe("итог забега с подстройкой", () => {
  const options = { runId: "r", seed: 31, outcome: "died", startingWeaponId: "", contentHash: CONTENT_HASH } as const;

  it("несёт силу и уровень давления с точностью до сотых", () => {
    const run = newRun({ ...LOADOUT, deviceClass: "light" });
    advance(run, 30);
    const result = buildRunResult(run.world, options);

    const start = describePressureStart(run.world);
    expect(start).toEqual({ power: result.pressure?.power, level: result.pressure?.level, deviceClass: "light" });
    expect(result.pressure?.deviceClass).toBe("light");
    for (const value of [result.pressure?.power, result.pressure?.level, result.pressure?.powerEnd, result.pressure?.levelEnd]) {
      expect(typeof value).toBe("number");
      expect(Math.round((value ?? 0) * 100) / 100).toBe(value);
    }
    expect(result.pressure?.power).toBe(Math.round(run.world.difficulty.startPower * 100) / 100);
    expect(result.pressure?.powerEnd).toBe(Math.round(run.world.difficulty.power * 100) / 100);
  });

  it("у обычного устройства класс — standard", () => {
    const run = newRun(LOADOUT);
    expect(buildRunResult(run.world, options).pressure?.deviceClass).toBe("standard");
  });

  it("без уровня аккаунта поля pressure в итоге нет", () => {
    const run = newRun({ modifiers: {}, boosts: [] });
    const result = buildRunResult(run.world, options);
    expect(result.pressure).toBeUndefined();
    expect("pressure" in result).toBe(false);
  });
});
