import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { STATUS_PULSE_ON, STATUS_PULSE_TICKS, STATUS_TONE, STATUS_TONE_COLORS, statusTone } from "../src/game/render/status-tones";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";

/**
 * Тон состояния на канве (docs/35-stage4-plan.md, WP6): какой тон видит игрок
 * и когда. Сам спрайт красит рендер; здесь — правило выбора, без Phaser.
 */

const DUMMY: EnemyDef = { id: "dummy", hp: 100, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };

function withEnemy(): { world: World; index: number } {
  const world = createWorld({ seed: 1, enemies: [DUMMY], weapons: [] });
  const index = spawnEnemy(world, 0, 300, 0);
  if (index < 0) throw new Error("пул исчерпан");
  return { world, index };
}

/** Тики одного периода пульса, в которые у слота виден тон. */
function onTicks(world: World, index: number): number {
  let on = 0;
  for (let tick = 0; tick < STATUS_PULSE_TICKS; tick++) {
    if (statusTone(world.enemies, index, tick) !== STATUS_TONE.none) on++;
  }
  return on;
}

describe("тон состояния", () => {
  it("без состояний тона нет", () => {
    const { world, index } = withEnemy();
    expect(onTicks(world, index)).toBe(0);
  });

  it("заморозка видна каждый тик, остальные — пульсом", () => {
    const { world, index } = withEnemy();
    world.enemies.frozenTimer[index] = 1;
    expect(onTicks(world, index)).toBe(STATUS_PULSE_TICKS);

    world.enemies.frozenTimer[index] = 0;
    world.enemies.burnTimer[index] = 1;
    expect(onTicks(world, index)).toBe(STATUS_PULSE_ON);
  });

  it("из нескольких состояний виден важнейший для боя", () => {
    const { world, index } = withEnemy();
    const enemies = world.enemies;
    enemies.chillTimer[index] = 1;
    enemies.poisonTimer[index] = 1;
    enemies.burnTimer[index] = 1;
    enemies.shockTimer[index] = 1;
    const shown = (): number => {
      for (let tick = 0; tick < STATUS_PULSE_TICKS; tick++) {
        const tone = statusTone(enemies, index, tick);
        if (tone !== STATUS_TONE.none) return tone;
      }
      return STATUS_TONE.none;
    };

    expect(shown()).toBe(STATUS_TONE.shock);
    enemies.shockTimer[index] = 0;
    expect(shown()).toBe(STATUS_TONE.burn);
    enemies.burnTimer[index] = 0;
    expect(shown()).toBe(STATUS_TONE.poison);
    enemies.poisonTimer[index] = 0;
    expect(shown()).toBe(STATUS_TONE.chill);
    enemies.frozenTimer[index] = 1;
    expect(shown()).toBe(STATUS_TONE.frozen);
  });

  it("соседние слоты пульсируют не в такт — толпа не вспыхивает стробоскопом", () => {
    const world = createWorld({ seed: 1, enemies: [DUMMY], weapons: [] });
    const first = spawnEnemy(world, 0, 300, 0);
    const second = spawnEnemy(world, 0, -300, 0);
    world.enemies.burnTimer[first] = 1;
    world.enemies.burnTimer[second] = 1;
    const phase = (index: number) =>
      Array.from({ length: STATUS_PULSE_TICKS }, (_, tick) => statusTone(world.enemies, index, tick));
    expect(phase(second)).not.toEqual(phase(first));
  });

  it("у каждого тона свой цвет", () => {
    const tones = Object.values(STATUS_TONE).filter((tone) => tone !== STATUS_TONE.none);
    expect(new Set(tones.map((tone) => STATUS_TONE_COLORS[tone])).size).toBe(tones.length);
    expect(STATUS_TONE_COLORS).toHaveLength(tones.length + 1);
  });
});
