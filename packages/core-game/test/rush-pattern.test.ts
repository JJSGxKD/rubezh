import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";
import { stepWorld } from "../src/game/sim/step";
import { RUSH_PHASE } from "../src/game/patterns";

// Пробегающий рой: целится с упреждением, проносится мимо и заходит снова.

const BATS: EnemyDef = {
  id: "bats",
  hp: 100,
  speed: 300,
  damage: 1,
  xp: 1,
  pattern: "rush",
  params: { leadSec: 0.5, runSec: 1 },
};

const CENTER = 0;

function world(): World {
  return createWorld({
    seed: 3,
    enemies: [BATS],
    config: { progressionEnabled: false },
  });
}

function distanceToPlayer(w: World, slot: number): number {
  const dx = w.enemies.x[slot] - w.player.x;
  const dy = w.enemies.y[slot] - w.player.y;
  return Math.sqrt(dx * dx + dy * dy);
}

describe("пробегающий рой", () => {
  it("проносится мимо и уходит дальше, а не разворачивается сразу", () => {
    const w = world();
    const slot = spawnEnemy(w, 0, CENTER - 300, CENTER);

    let closest = Infinity;
    // 90 тиков — полторы секунды: рой успевает добежать и уйти за спину.
    for (let i = 0; i < 90; i++) {
      stepWorld(w, { moveX: 0, moveY: 0 });
      closest = Math.min(closest, distanceToPlayer(w, slot));
    }

    // Дошёл вплотную и к концу пробега оказался уже за игроком.
    expect(closest).toBeLessThan(40 * w.config.unitScale);
    expect(distanceToPlayer(w, slot)).toBeGreaterThan(closest * 2);
    expect(w.enemies.phase[slot]).toBe(RUSH_PHASE.running);
  });

  it("берёт упреждение: целится туда, где игрок окажется", () => {
    const w = world();
    // Игрок бежит вправо, рой заходит снизу: без упреждения он шёл бы точно
    // вверх, с упреждением — вправо и вверх.
    for (let i = 0; i < 30; i++) stepWorld(w, { moveX: 1, moveY: 0 });
    const slot = spawnEnemy(w, 0, w.player.x, w.player.y + 400);
    stepWorld(w, { moveX: 1, moveY: 0 });

    expect(w.enemies.vy[slot]).toBeLessThan(0);
    expect(w.enemies.vx[slot]).toBeGreaterThan(0);
  });

  it("после пробега заходит на новый круг", () => {
    const w = world();
    const slot = spawnEnemy(w, 0, CENTER - 200, CENTER);
    stepWorld(w, { moveX: 0, moveY: 0 });
    expect(w.enemies.vx[slot]).toBeGreaterThan(0);

    // runSec = 1 с: за секунду рой проносится мимо, а на 61-м тике целится
    // заново — уже в обратную сторону.
    for (let i = 0; i < 62; i++) stepWorld(w, { moveX: 0, moveY: 0 });

    expect(w.enemies.vx[slot]).toBeLessThan(0);
  });
});
