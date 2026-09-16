import type { EnemyDef, EnemyStageDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { createWorld, spawnEnemy, stageOf, type World } from "../src/game/sim/world";
import { killEnemy } from "../src/game/sim/combat";
import { enemySpeed } from "../src/game/patterns/steering";

// Ступени врагов: та же тварь, но матёрее (docs/26-stage2-plan.md, WP4.8).

const RAT: EnemyDef = { id: "rat", hp: 10, speed: 60, damage: 4, xp: 2, pattern: "swarm" };
const BOSS: EnemyDef = { id: "elite", hp: 100, speed: 30, damage: 9, xp: 20, elite: true, pattern: "chase" };

const STAGES: EnemyStageDef[] = [
  { fromSec: 0, weight: 1, hpMul: 1, damageMul: 1, speedMul: 1, xpMul: 1 },
  { fromSec: 60, weight: 1, hpMul: 2, damageMul: 1.5, speedMul: 1.2, xpMul: 3, nameKey: "s2" },
];

function world(): World {
  return createWorld({
    seed: 7,
    enemies: [RAT, BOSS],
    stages: STAGES,
    config: { progressionEnabled: false },
  });
}

/** Ступени, доставшиеся сотне врагов, вышедших на указанной секунде. */
function stagesAt(w: World, elapsedSec: number): Set<number> {
  w.stats.elapsedSec = elapsedSec;
  const seen = new Set<number>();
  for (let i = 0; i < 100; i++) {
    const slot = spawnEnemy(w, 0, 200 + i, 0);
    if (slot < 0) break;
    seen.add(w.enemies.stage[slot]);
  }
  return seen;
}

describe("ступени врагов", () => {
  it("до открытия второй ступени приходит только первая", () => {
    expect(stagesAt(world(), 30)).toEqual(new Set([0]));
  });

  it("после открытия приходят обе: прежняя ступень из потока не уходит", () => {
    expect(stagesAt(world(), 120)).toEqual(new Set([0, 1]));
  });

  it("матёрый враг живучее, больнее бьёт и быстрее ходит", () => {
    const w = world();
    w.stats.elapsedSec = 120;

    let hardened = -1;
    for (let i = 0; i < 100 && hardened < 0; i++) {
      const slot = spawnEnemy(w, 0, 200 + i, 0);
      if (slot >= 0 && w.enemies.stage[slot] === 1) hardened = slot;
    }
    expect(hardened).toBeGreaterThanOrEqual(0);

    expect(w.enemies.hp[hardened]).toBeCloseTo(RAT.hp * 2, 5);
    expect(w.enemies.damage[hardened]).toBeCloseTo(RAT.damage * 1.5, 5);
    expect(enemySpeed(w, hardened)).toBeCloseTo(w.enemyTypes[0].speed * 1.2, 5);
  });

  it("опыт с матёрого больше: иначе его незачем убивать", () => {
    // Выпадение включается отдельно: прокачка тестам не нужна, а кристаллы — да.
    const w = createWorld({
      seed: 7,
      enemies: [RAT, BOSS],
      stages: STAGES,
      config: { progressionEnabled: false, lootEnabled: true },
    });
    w.stats.elapsedSec = 120;
    let hardened = -1;
    for (let i = 0; i < 100 && hardened < 0; i++) {
      const slot = spawnEnemy(w, 0, 200 + i, 0);
      if (slot >= 0 && w.enemies.stage[slot] === 1) hardened = slot;
    }

    const before = w.gems.count;
    killEnemy(w, hardened);
    let dropped = 0;
    for (let i = before; i < w.gems.count; i++) dropped += w.gems.value[i];

    expect(dropped).toBe(RAT.xp * 3);
  });

  it("ступень застывает: открытие новой не усиливает уже вышедших", () => {
    const w = world();
    w.stats.elapsedSec = 10;
    const early = spawnEnemy(w, 0, 200, 0);

    w.stats.elapsedSec = 120;
    expect(w.enemies.stage[early]).toBe(0);
    expect(stageOf(w, early).hpMul).toBe(1);
  });

  it("элита ступеней не получает: она сама и есть контрольная точка", () => {
    const w = world();
    w.stats.elapsedSec = 300;
    for (let i = 0; i < 20; i++) {
      const slot = spawnEnemy(w, 1, 200 + i, 0);
      expect(w.enemies.stage[slot]).toBe(0);
    }
  });
});
