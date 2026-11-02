import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { DASH_PHASE } from "../src/game/patterns";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { vectorLength } from "../src/game/sim/vector";
import { createWorld, DEFAULT_SIM_CONFIG, spawnEnemy, TICK_SEC, type World } from "../src/game/sim/world";

// Поведение Тарана (T-0197): босс на уворот — телеграф, рывок по прямой,
// долгая пауза; ничего не порождает и не стреляет.

const RAM = ENEMIES.filter((enemy) => enemy.id === "boss_ram");

function setup(): World {
  return createWorld({
    seed: 1,
    enemies: RAM,
    weapons: [],
    config: {
      maxEnemies: 64,
      progressionEnabled: false,
      player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 },
    },
  });
}

function place(world: World, dx: number): number {
  const slot = spawnEnemy(world, 0, dx, 0);
  if (slot < 0) throw new Error("Пул исчерпан при подготовке теста");
  return slot;
}

function tick(world: World): void {
  stepWorld(world, IDLE_INPUT);
}

function speedOf(world: World, slot: number): number {
  return vectorLength(world.enemies.vx[slot], world.enemies.vy[slot]);
}

describe("Таран", () => {
  it("мигает, прежде чем рвануть: фазы по порядку, телеграф не движется", () => {
    const world = setup();
    const slot = place(world, 400);
    const seen: number[] = [];
    let telegraphTicks = 0;
    const telegraphX: number[] = [];
    for (let i = 0; i < 600; i++) {
      tick(world);
      const phase = world.enemies.phase[slot];
      if (seen[seen.length - 1] !== phase) seen.push(phase);
      if (phase === DASH_PHASE.telegraph) {
        telegraphTicks++;
        telegraphX.push(world.enemies.x[slot]);
      }
      if (seen.length >= 4 && phase === DASH_PHASE.recover) break;
    }
    expect(seen.slice(0, 4)).toEqual([DASH_PHASE.approach, DASH_PHASE.telegraph, DASH_PHASE.dash, DASH_PHASE.recover]);
    expect(Math.abs(telegraphTicks - 0.9 / TICK_SEC)).toBeLessThanOrEqual(1);
    expect(Math.max(...telegraphX) - Math.min(...telegraphX)).toBeCloseTo(0, 5);
  });

  it("фиксирует направление рывка в начале телеграфа", () => {
    const world = setup();
    const slot = place(world, 280);
    let guard = 0;
    while (world.enemies.phase[slot] !== DASH_PHASE.telegraph && guard++ < 600) tick(world);
    expect(world.enemies.phase[slot]).toBe(DASH_PHASE.telegraph);
    const dirX = world.enemies.dirX[slot];
    const dirY = world.enemies.dirY[slot];
    // Игрок уходит вбок за время телеграфа.
    world.player.x = 0;
    world.player.y = 250;
    world.player.prevX = 0;
    world.player.prevY = 250;
    guard = 0;
    while (world.enemies.phase[slot] !== DASH_PHASE.dash && guard++ < 600) tick(world);
    expect(world.enemies.phase[slot]).toBe(DASH_PHASE.dash);
    expect(world.enemies.dirX[slot]).toBeCloseTo(dirX, 6);
    expect(world.enemies.dirY[slot]).toBeCloseTo(dirY, 6);
    tick(world);
    const speed = speedOf(world, slot);
    expect(speed).toBeGreaterThan(0);
    expect((world.enemies.vx[slot] * dirX + world.enemies.vy[slot] * dirY) / speed).toBeCloseTo(1, 3);
  });

  it("после рывка стоит на месте всю паузу", () => {
    const world = setup();
    const slot = place(world, 280);
    let guard = 0;
    while (world.enemies.phase[slot] !== DASH_PHASE.recover && guard++ < 900) tick(world);
    expect(world.enemies.phase[slot]).toBe(DASH_PHASE.recover);
    let recoverTicks = 0;
    while (world.enemies.phase[slot] === DASH_PHASE.recover && recoverTicks < 400) {
      expect(speedOf(world, slot)).toBe(0);
      tick(world);
      recoverTicks++;
    }
    expect(Math.abs(recoverTicks - 1.8 / TICK_SEC)).toBeLessThanOrEqual(2);
  });

  it("ничего не порождает и не стреляет", () => {
    const world = setup();
    place(world, 280);
    for (let i = 0; i < 20 / TICK_SEC; i++) {
      tick(world);
      expect(world.enemies.aliveCount).toBeLessThanOrEqual(1);
      expect(world.projectiles.aliveCount).toBe(0);
    }
  });
});
