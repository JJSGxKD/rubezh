import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";
import { damageEnemy } from "../src/game/sim/combat";
import { stepWorld, IDLE_INPUT } from "../src/game/sim/step";
import { CASTER_PHASE } from "../src/game/patterns";

// Кастующий босс: замирает, бьёт по площади и звереет к концу боя.

const SEER: EnemyDef = {
  id: "seer",
  hp: 1000,
  speed: 40,
  damage: 5,
  xp: 10,
  rank: "boss",
  pattern: "caster",
  params: { preferredDistance: 260, castIntervalSec: 2, telegraphSec: 0.5, burstCount: 6, projectileSpeed: 200 },
};

function world(): World {
  return createWorld({ seed: 4, enemies: [SEER], config: { progressionEnabled: false } });
}

function aliveProjectiles(w: World): number {
  let count = 0;
  for (let i = 0; i < w.projectiles.count; i++) if (w.projectiles.alive[i] === 1) count++;
  return count;
}

/** Прогнать до ближайшего каста и вернуть, сколько снарядов он выпустил. */
function castOnce(w: World, slot: number): number {
  for (let i = 0; i < 60 * 12; i++) {
    const before = aliveProjectiles(w);
    const windup = w.enemies.phase[slot] === CASTER_PHASE.windup;
    stepWorld(w, IDLE_INPUT);
    const after = aliveProjectiles(w);
    if (windup && after > before) return after - before;
  }
  throw new Error("Кастер не ударил за двенадцать секунд");
}

describe("кастующий босс", () => {
  it("замирает перед ударом: телеграф — это время игрока уйти с линии", () => {
    const w = world();
    const slot = spawnEnemy(w, 0, 600, 0);

    for (let i = 0; i < 60 * 12; i++) {
      stepWorld(w, IDLE_INPUT);
      if (w.enemies.phase[slot] !== CASTER_PHASE.windup) continue;

      expect(w.enemies.vx[slot]).toBe(0);
      expect(w.enemies.vy[slot]).toBe(0);
      expect(w.enemies.phaseTimer[slot]).toBeGreaterThan(0);
      return;
    }
    throw new Error("Кастер ни разу не замер перед ударом");
  });

  it("бьёт по площади, а не касанием: снаряды появляются, урона от тела нет", () => {
    const w = world();
    const slot = spawnEnemy(w, 0, 600, 0);

    expect(castOnce(w, slot)).toBeGreaterThan(1);
    expect(w.stats.damageTaken).toBe(0);
  });

  it("в последней фазе бьёт гуще: два заклинания вместо одного", () => {
    const fresh = world();
    const healthy = spawnEnemy(fresh, 0, 600, 0);
    const first = castOnce(fresh, healthy);

    const wounded = world();
    const hurt = spawnEnemy(wounded, 0, 600, 0);
    // Добиваем до последней фазы: полоса босса и его поведение считают её
    // от одной и той же доли здоровья.
    damageEnemy(wounded, hurt, SEER.hp * 0.8, 0);
    const last = castOnce(wounded, hurt);

    expect(last).toBeGreaterThan(first);
  });

  it("выбирает заклинание случайно: два seed дают разные картины", () => {
    const counts = new Set<number>();
    for (let seed = 1; seed <= 6; seed++) {
      const w = createWorld({ seed, enemies: [SEER], config: { progressionEnabled: false } });
      const slot = spawnEnemy(w, 0, 600, 0);
      counts.add(castOnce(w, slot));
    }

    expect(counts.size).toBeGreaterThan(1);
  });
});
