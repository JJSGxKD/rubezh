import { describe, expect, it } from "vitest";
import { findDifficulty } from "../src/content/difficulty";
import { DROPS } from "../src/content/drops";
import { ENEMIES } from "../src/content/enemies";
import { MAPS } from "../src/content/maps";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../src/content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { chooseUpgrade, isAwaitingChoice } from "../src/game/progression/levels";
import { captureWorld, restoreWorld, SnapshotError } from "../src/game/run/snapshot";
import { createTimelineDirector } from "../src/game/sim/director";
import type { Spawner } from "../src/game/sim/spawner";
import { stepWorld, type SimInput } from "../src/game/sim/step";
import { createWorld, TICK_SEC, type World } from "../src/game/sim/world";
import { checksumWorld } from "./helpers/scripted-run";

// Продолжение прерванного забега (game/run/snapshot.ts): снимок, записанный в
// строку и прочитанный обратно, обязан дать ровно тот же забег, что шёл бы без
// перерыва. Иначе «продолжить» — это другой забег с тем же номером.

interface Run {
  world: World;
  director: Spawner;
}

function newRun(seed: number): Run {
  return {
    world: createWorld({
      seed,
      enemies: ENEMIES,
      weapons: WEAPONS,
      passives: PASSIVES,
      levelCurve: LEVEL_CURVE,
      loadoutLimits: LOADOUT_LIMITS,
      drops: DROPS,
      map: MAPS[0],
    }),
    director: createTimelineDirector(TIMELINE, ENDLESS_CURVE),
  };
}

/**
 * Ввод, зависящий только от тика. Бот калибровки не годится: он смотрит в
 * сетку коллизий и помнит прошлое направление, а это состояние теста, а не
 * мира, — расхождение померило бы бота, а не снимок.
 */
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

function advance(run: Run, ticks: number): void {
  for (let done = 0; done < ticks && run.world.player.alive; ) {
    if (isAwaitingChoice(run.world)) {
      // Второй вариант, а не первый: так в набор попадают и пассивки.
      const offers = run.world.progression.offers;
      chooseUpgrade(run.world, (offers[1] ?? offers[0]).id);
      continue;
    }
    run.director.update(run.world, TICK_SEC);
    stepWorld(run.world, DIRECTIONS[Math.floor(run.world.stats.tick / 90) % DIRECTIONS.length]);
    done++;
  }
}

function roundTrip(run: Run): unknown {
  return JSON.parse(JSON.stringify(captureWorld(run.world, run.director)));
}

describe("снимок забега", () => {
  // Гоняет мир минутами: в полном прогоне монорепо пяти секунд Vitest не хватает.
  it("продолженный забег идёт ровно так же, как непрерванный", { timeout: 30_000 }, () => {
    const original = newRun(4242);
    advance(original, 60 * 60);
    const saved = roundTrip(original);

    const resumed = newRun(4242);
    restoreWorld(resumed.world, resumed.director, saved);
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));

    advance(original, 90 * 60);
    advance(resumed, 90 * 60);

    // Прогон должен дойти до прокачки и бесконечного таймлайна, иначе
    // проверка обходит самые хрупкие части состояния.
    expect(original.world.loadout.passives.length).toBeGreaterThan(0);
    expect(original.world.stats.enemiesKilled).toBeGreaterThan(100);
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));
    expect(resumed.world.stats).toEqual(original.world.stats);
    expect(resumed.world.rng.getState()).toBe(original.world.rng.getState());
  });

  it("продолжает на той же сложности: мир из снимка создаётся с её поправками", () => {
    const hard = findDifficulty("hard");
    if (hard === undefined) throw new Error("нет сложности hard");
    const make = (): Run => {
      const run = newRun(12);
      run.world = createWorld({
        seed: 12,
        enemies: ENEMIES,
        weapons: WEAPONS,
        passives: PASSIVES,
        levelCurve: LEVEL_CURVE,
        loadoutLimits: LOADOUT_LIMITS,
        drops: DROPS,
        map: MAPS[0],
        difficulty: hard,
      });
      return run;
    };

    const original = make();
    advance(original, 70 * 60);
    const resumed = make();
    restoreWorld(resumed.world, resumed.director, roundTrip(original));
    advance(original, 30 * 60);
    advance(resumed, 30 * 60);

    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));
    expect(resumed.world.difficulty.hpMul).toBeGreaterThan(1);
  });

  it("сохраняет забег, остановленный на выборе улучшения, вместе с вариантами", () => {
    const original = newRun(77);
    while (!isAwaitingChoice(original.world)) {
      original.director.update(original.world, TICK_SEC);
      stepWorld(original.world, DIRECTIONS[0]);
    }

    const resumed = newRun(77);
    restoreWorld(resumed.world, resumed.director, roundTrip(original));
    expect(isAwaitingChoice(resumed.world)).toBe(true);
    expect(resumed.world.progression.offers).toEqual(original.world.progression.offers);
  });

  it("не меняет мир, с которого снят", () => {
    const run = newRun(9);
    advance(run, 20 * 60);
    const before = checksumWorld(run.world);
    const snapshot = captureWorld(run.world, run.director);

    advance(run, 60);
    expect(snapshot.progression.level).toBeLessThanOrEqual(run.world.progression.level);
    expect(before).not.toBe(checksumWorld(run.world));
  });

  it("отказывается читать снимок другой версии формата", () => {
    const run = newRun(1);
    const saved = roundTrip(run) as Record<string, unknown>;
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, { ...saved, version: 999 })).toThrow(
      SnapshotError,
    );
  });

  it("отказывается читать испорченный снимок, а не рождает мир с NaN", () => {
    const run = newRun(1);
    advance(run, 5 * 60);
    const saved = roundTrip(run) as { player: Record<string, unknown>; enemies: { arrays: Record<string, { data: string }> } };

    const brokenPlayer = { ...saved, player: { ...saved.player, x: null } };
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, brokenPlayer)).toThrow(SnapshotError);

    const brokenArray = structuredClone(saved);
    brokenArray.enemies.arrays.x.data = "не base64 вовсе";
    expect(() => restoreWorld(newRun(1).world, newRun(1).director, brokenArray)).toThrow(SnapshotError);

    expect(() => restoreWorld(newRun(1).world, newRun(1).director, "мусор")).toThrow(SnapshotError);
  });
});
