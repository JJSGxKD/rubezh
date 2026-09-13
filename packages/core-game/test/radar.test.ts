import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { buildRadarSnapshot, MAX_BLIPS } from "../src/game/radar";
import { spawnMedkit } from "../src/game/sim/medkits";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";

// Снимок радара для HUD: точки вокруг игрока.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const BOSS: EnemyDef = { id: "boss", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", elite: true };

function setup(): World {
  return createWorld({ seed: 1, enemies: [GRUNT, BOSS], config: { maxEnemies: 256 } });
}

function blip(snapshot: ReturnType<typeof buildRadarSnapshot>, index: number): [number, number, number] {
  const base = index * 3;
  return [snapshot.blips[base], snapshot.blips[base + 1], snapshot.blips[base + 2]];
}

describe("радар", () => {
  it("ставит точки относительно игрока в долях радиуса кольца спавна", () => {
    const world = setup();
    const range = world.config.view.spawnRadius;
    world.player.x = 100;
    spawnEnemy(world, 0, 100 + range / 2, 0);

    const snapshot = buildRadarSnapshot(world);
    expect(snapshot.count).toBe(1);
    const [x, y, kind] = blip(snapshot, 0);
    expect(x).toBeCloseTo(0.5, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(kind).toBe(0);
  });

  it("прижимает дальние точки к краю, а не выбрасывает их", () => {
    const world = setup();
    spawnEnemy(world, 0, 0, world.config.view.spawnRadius * 3);

    const [x, y] = blip(buildRadarSnapshot(world), 0);
    expect(Math.hypot(x, y)).toBeCloseTo(1, 5);
    expect(y).toBeCloseTo(1, 5);
  });

  it("при переполнении кладёт элиты и аптечки первыми", () => {
    const world = setup();
    for (let k = 0; k < MAX_BLIPS + 20; k++) spawnEnemy(world, 0, k, 0);
    spawnEnemy(world, 1, 5, 5);
    spawnMedkit(world, -5, -5);

    const snapshot = buildRadarSnapshot(world);
    const kinds = Array.from({ length: snapshot.count }, (_, i) => blip(snapshot, i)[2]);

    expect(snapshot.count).toBe(MAX_BLIPS);
    expect(kinds).toContain(1);
    expect(kinds).toContain(2);
  });
});
