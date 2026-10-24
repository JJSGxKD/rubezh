import { readFileSync } from "node:fs";
import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { keepsFill, MARK_FRAME_TICKS, markFrame, STATUS_MARK_FRAMES } from "../src/game/render/status-marks";
import { activeStatus, STATUS_TONE, statusTone } from "../src/game/render/status-tones";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";

/**
 * Знаки состояний над врагами-спрайтами (design/art/direction-v2.md §4.5):
 * какой знак, какой кадр и где заливка остаётся. Рисует `StatusMarks`.
 */

const DUMMY: EnemyDef = { id: "dummy", hp: 100, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };

function withEnemy(): { world: World; index: number } {
  const world = createWorld({ seed: 1, enemies: [DUMMY], weapons: [] });
  const index = spawnEnemy(world, 0, 300, 0);
  if (index < 0) throw new Error("пул исчерпан");
  return { world, index };
}

const atlas = JSON.parse(readFileSync(new URL("../../../design/art/out/atlas-core.json", import.meta.url), "utf8")) as { frames: Record<string, unknown> };

describe("знак состояния", () => {
  it("у каждого состояния есть знак, и его кадры лежат в атласе core", () => {
    const tones = Object.values(STATUS_TONE).filter((tone) => tone !== STATUS_TONE.none);
    for (const tone of tones) {
      const frames = STATUS_MARK_FRAMES[tone] ?? [];
      expect(frames.length, `тон ${String(tone)}`).toBeGreaterThan(0);
      for (const name of frames) expect(atlas.frames[name], name).toBeDefined();
    }
  });

  it("знак не мигает: виден, пока длится состояние, а не тактом пульса", () => {
    const { world, index } = withEnemy();
    world.enemies.burnTimer[index] = 1;
    let pulsed = 0;
    for (let tick = 0; tick < 60; tick++) {
      expect(activeStatus(world.enemies, index)).toBe(STATUS_TONE.burn);
      if (statusTone(world.enemies, index, tick) === STATUS_TONE.none) pulsed++;
    }
    // Заливка фигуры мигает — знак спрайта нет.
    expect(pulsed).toBeGreaterThan(0);
  });

  it("из нескольких состояний — важнее для боя: заморозка, шок, горение, яд, холод", () => {
    const { world, index } = withEnemy();
    const enemies = world.enemies;
    enemies.chillTimer[index] = 1;
    expect(activeStatus(enemies, index)).toBe(STATUS_TONE.chill);
    enemies.poisonTimer[index] = 1;
    expect(activeStatus(enemies, index)).toBe(STATUS_TONE.poison);
    enemies.burnTimer[index] = 1;
    expect(activeStatus(enemies, index)).toBe(STATUS_TONE.burn);
    enemies.shockTimer[index] = 1;
    expect(activeStatus(enemies, index)).toBe(STATUS_TONE.shock);
    enemies.frozenTimer[index] = 1;
    expect(activeStatus(enemies, index)).toBe(STATUS_TONE.frozen);
  });

  it("заливка остаётся только у заморозки — ледяная статуя", () => {
    for (const tone of Object.values(STATUS_TONE)) expect(keepsFill(tone)).toBe(tone === STATUS_TONE.frozen);
  });

  it("кадры дрожат вразнобой: соседние слоты в разной фазе, один кадр стоит", () => {
    expect(markFrame(1, 123, 4)).toBe(0);
    expect(markFrame(2, 0, 0)).toBe(0);
    expect(markFrame(2, MARK_FRAME_TICKS, 0)).toBe(1);
    expect(markFrame(2, MARK_FRAME_TICKS * 2, 0)).toBe(0);
    const phases = new Set(Array.from({ length: 8 }, (_, slot) => markFrame(2, 3, slot)));
    expect(phases.size).toBe(2);
  });
});
