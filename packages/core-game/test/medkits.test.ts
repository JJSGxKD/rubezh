import type { DropsDef, EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { DROPS } from "../src/content/drops";
import { SIM_EVENT } from "../src/game/sim/events";
import {
  findMedkitContentProblems,
  MEDKIT_LAND_TICKS,
  rollMedkit,
  spawnMedkit,
  updateMedkits,
} from "../src/game/sim/medkits";
import { killEnemy } from "../src/game/sim/combat";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";

// Аптечки: выпадение с врагов, подбор касанием, лечение.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const BOSS: EnemyDef = { id: "boss", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", elite: true };

function setup(medkits: Partial<DropsDef["medkits"]> = {}, seed = 1): World {
  return createWorld({
    seed,
    enemies: [GRUNT, BOSS],
    drops: {
      gems: { maxPerKill: 1 },
      medkits: { chance: 1, eliteChance: 1, healRatio: 0.3, maxOnField: 3, ...medkits },
    },
  });
}

/** Дать аптечке приземлиться, не гоняя весь шаг симуляции. */
function land(world: World): void {
  world.stats.tick += MEDKIT_LAND_TICKS;
}

describe("аптечки", () => {
  it("падает с врага по шансу, а элита роняет свою по отдельному шансу", () => {
    const world = setup({ chance: 0, eliteChance: 1 });

    killEnemy(world, spawnEnemy(world, 0, 100, 0));
    expect(world.medkits.aliveCount).toBe(0);

    killEnemy(world, spawnEnemy(world, 1, 100, 0));
    expect(world.medkits.aliveCount).toBe(1);
  });

  it("выпадает с заданной частотой, а не всегда и не никогда", () => {
    const world = setup({ chance: 0.25, maxOnField: 8 });
    let dropped = 0;
    for (let k = 0; k < 400; k++) {
      rollMedkit(world, 0, 0, false);
      dropped += world.medkits.aliveCount;
      world.medkits.alive.fill(0);
      world.medkits.aliveCount = 0;
    }
    expect(dropped).toBeGreaterThan(70);
    expect(dropped).toBeLessThan(130);
  });

  it("не падает сверх потолка на поле", () => {
    const world = setup({ maxOnField: 2 });
    for (let k = 0; k < 5; k++) rollMedkit(world, 0, 0, false);
    expect(world.medkits.aliveCount).toBe(2);
  });

  it("с нулевым шансом не трогает генератор", () => {
    const world = setup({ chance: 0 });
    const state = world.rng.getState();
    rollMedkit(world, 0, 0, false);
    expect(world.rng.getState()).toBe(state);
  });

  it("лечит долю максимального здоровья при касании и пишет событие для рендера", () => {
    const world = setup();
    world.player.hp = 40;
    spawnMedkit(world, world.player.x, world.player.y);
    land(world);

    updateMedkits(world);

    expect(world.player.hp).toBe(40 + world.playerStats.maxHp * 0.3);
    expect(world.medkits.aliveCount).toBe(0);
    expect(world.stats.medkitsCollected).toBe(1);
    const last = (world.events.written - 1) % world.events.kind.length;
    expect(world.events.kind[last]).toBe(SIM_EVENT.heal);
    expect(world.events.radius[last]).toBeCloseTo(world.playerStats.maxHp * 0.3, 6);
  });

  it("не лечит сверх максимума", () => {
    const world = setup({ healRatio: 1 });
    world.player.hp = world.playerStats.maxHp - 5;
    spawnMedkit(world, world.player.x, world.player.y);
    land(world);
    updateMedkits(world);
    expect(world.player.hp).toBe(world.playerStats.maxHp);
  });

  it("с полным здоровьем остаётся лежать — вернуться за ней решает игрок", () => {
    const world = setup();
    spawnMedkit(world, world.player.x, world.player.y);
    land(world);
    updateMedkits(world);
    expect(world.medkits.aliveCount).toBe(1);
  });

  it("в полёте не подбирается", () => {
    const world = setup();
    world.player.hp = 10;
    spawnMedkit(world, world.player.x, world.player.y);
    updateMedkits(world);
    expect(world.player.hp).toBe(10);
    expect(world.medkits.aliveCount).toBe(1);
  });

  it("не подбирается издалека: притяжения, как у кристаллов, нет", () => {
    const world = setup();
    world.player.hp = 10;
    spawnMedkit(world, world.player.x + 60, world.player.y);
    land(world);
    updateMedkits(world);
    expect(world.medkits.aliveCount).toBe(1);
  });
});

describe("контент аптечек", () => {
  it("боевой контент корректен", () => {
    expect(findMedkitContentProblems(DROPS.medkits)).toEqual([]);
  });

  it("называет поле с ошибкой", () => {
    const problems = findMedkitContentProblems({ chance: 2, eliteChance: -1, healRatio: 0, maxOnField: 99 });
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/chance.*eliteChance|eliteChance/s);
  });
});
