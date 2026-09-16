import type { DropsDef, EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { DROPS } from "../src/content/drops";
import { SIM_EVENT } from "../src/game/sim/events";
import { spawnGem } from "../src/game/sim/gems";
import {
  countOnField,
  findPickupContentProblems,
  PICKUP_KIND,
  PICKUP_LAND_TICKS,
  rollPickups,
  spawnPickup,
  updatePickups,
} from "../src/game/sim/pickups";
import { killEnemy } from "../src/game/sim/combat";
import { PICKUP_LOOKS } from "../src/game/render/looks";
import { createWorld, spawnEnemy, type World } from "../src/game/sim/world";

// Подборы: аптечка, магнит и динамит — выпадение с врагов, подбор касанием,
// действие.

const GRUNT: EnemyDef = { id: "grunt", hp: 10, speed: 0.001, damage: 0, xp: 1, pattern: "swarm" };
const BOSS: EnemyDef = { id: "boss", hp: 100, speed: 0.001, damage: 0, xp: 1, pattern: "swarm", elite: true };
const SLIME: EnemyDef = {
  id: "slime",
  hp: 10,
  speed: 0.001,
  damage: 0,
  xp: 1,
  pattern: "splitter",
  params: { childEnemy: "grunt", childCount: 2 },
};

const NONE = { chance: 0, eliteChance: 0, maxOnField: 0 };

function drops(patch: Partial<DropsDef> = {}): DropsDef {
  return {
    gems: { maxPerKill: 1 },
    medkits: { ...NONE, healRatio: 0.3 },
    magnets: NONE,
    dynamite: { ...NONE, radiusUnits: 200, eliteHpRatio: 0.3 },
    ...patch,
  };
}

function setup(patch: Partial<DropsDef> = {}, seed = 1): World {
  return createWorld({ seed, enemies: [GRUNT, BOSS, SLIME], drops: drops(patch) });
}

/** Дать подбору приземлиться, не гоняя весь шаг симуляции. */
function land(world: World): void {
  world.stats.tick += PICKUP_LAND_TICKS;
}

function lastEvent(world: World): { kind: number; radius: number } {
  const slot = (world.events.written - 1) % world.events.kind.length;
  return { kind: world.events.kind[slot], radius: world.events.radius[slot] };
}

describe("выпадение подборов", () => {
  it("падает с врага по шансу, а элита роняет по отдельному шансу", () => {
    const world = setup({ medkits: { chance: 0, eliteChance: 1, healRatio: 0.3, maxOnField: 3 } });

    killEnemy(world, spawnEnemy(world, 0, 100, 0));
    expect(world.pickups.aliveCount).toBe(0);

    killEnemy(world, spawnEnemy(world, 1, 100, 0));
    expect(countOnField(world, PICKUP_KIND.medkit)).toBe(1);
  });

  it("выпадает с заданной частотой, а не всегда и не никогда", () => {
    const world = setup({ magnets: { chance: 0.25, eliteChance: 0, maxOnField: 8 } });
    let dropped = 0;
    for (let k = 0; k < 400; k++) {
      rollPickups(world, 0, 0, false);
      dropped += world.pickups.aliveCount;
      world.pickups.alive.fill(0);
      world.pickups.aliveCount = 0;
    }
    expect(dropped).toBeGreaterThan(70);
    expect(dropped).toBeLessThan(130);
  });

  it("держит потолок на поле для каждого вида отдельно", () => {
    const world = setup({
      medkits: { chance: 1, eliteChance: 1, healRatio: 0.3, maxOnField: 2 },
      dynamite: { chance: 1, eliteChance: 1, maxOnField: 1, radiusUnits: 200, eliteHpRatio: 0.3 },
    });
    for (let k = 0; k < 5; k++) rollPickups(world, 0, 0, false);
    expect(countOnField(world, PICKUP_KIND.medkit)).toBe(2);
    expect(countOnField(world, PICKUP_KIND.dynamite)).toBe(1);
  });

  it("с нулевыми шансами не трогает генератор", () => {
    const world = setup();
    const state = world.rng.getState();
    rollPickups(world, 0, 0, true);
    expect(world.rng.getState()).toBe(state);
  });
});

describe("аптечка", () => {
  it("лечит долю максимального здоровья при касании и пишет событие для рендера", () => {
    const world = setup();
    world.player.hp = 40;
    spawnPickup(world, PICKUP_KIND.medkit, world.player.x, world.player.y);
    land(world);

    updatePickups(world);

    expect(world.player.hp).toBe(40 + world.playerStats.maxHp * 0.3);
    expect(world.pickups.aliveCount).toBe(0);
    expect(world.stats.medkitsCollected).toBe(1);
    expect(lastEvent(world).kind).toBe(SIM_EVENT.heal);
    expect(lastEvent(world).radius).toBeCloseTo(world.playerStats.maxHp * 0.3, 6);
  });

  it("не лечит сверх максимума", () => {
    const world = setup({ medkits: { ...NONE, healRatio: 1 } });
    world.player.hp = world.playerStats.maxHp - 5;
    spawnPickup(world, PICKUP_KIND.medkit, world.player.x, world.player.y);
    land(world);
    updatePickups(world);
    expect(world.player.hp).toBe(world.playerStats.maxHp);
  });

  it("с полным здоровьем остаётся лежать — вернуться за ней решает игрок", () => {
    const world = setup();
    spawnPickup(world, PICKUP_KIND.medkit, world.player.x, world.player.y);
    land(world);
    updatePickups(world);
    expect(world.pickups.aliveCount).toBe(1);
  });
});

describe("подбор касанием", () => {
  it("в полёте не подбирается", () => {
    const world = setup();
    world.player.hp = 10;
    spawnPickup(world, PICKUP_KIND.medkit, world.player.x, world.player.y);
    updatePickups(world);
    expect(world.player.hp).toBe(10);
    expect(world.pickups.aliveCount).toBe(1);
  });

  it("за радиусом сбора лежит и не двигается: бежать всё равно придётся", () => {
    const world = setup();
    const far = world.playerStats.pickupRadius * 2;
    spawnPickup(world, PICKUP_KIND.magnet, world.player.x + far, world.player.y);
    land(world);
    updatePickups(world);
    expect(world.pickups.aliveCount).toBe(1);
    expect(world.pickups.x[0] - world.player.x).toBe(far);
  });

  it("в радиусе сбора ползёт к игроку и ускоряется, чем ближе", () => {
    const world = setup();
    const radius = world.playerStats.pickupRadius;
    spawnPickup(world, PICKUP_KIND.magnet, world.player.x + radius * 0.95, world.player.y);
    spawnPickup(world, PICKUP_KIND.magnet, world.player.x + radius * 0.25, world.player.y);
    land(world);
    const [farStart, nearStart] = [world.pickups.x[0], world.pickups.x[1]];

    updatePickups(world);

    const farStep = farStart - world.pickups.x[0];
    const nearStep = nearStart - world.pickups.x[1];
    expect(farStep).toBeGreaterThan(0);
    expect(nearStep).toBeGreaterThan(farStep * 2);
    // Медленнее кристалла: кристалл с края радиуса долетает в разы быстрее.
    expect(farStep).toBeLessThan(radius / 10);
  });

  it("подтянутый вплотную подбор срабатывает сам", () => {
    const world = setup();
    world.player.hp = 10;
    spawnPickup(world, PICKUP_KIND.medkit, world.player.x + world.config.player.radius * 1.4, world.player.y);
    land(world);
    for (let tick = 0; tick < 60 && world.pickups.aliveCount > 0; tick++) updatePickups(world);
    expect(world.pickups.aliveCount).toBe(0);
    expect(world.player.hp).toBeGreaterThan(10);
  });
});

describe("магнит", () => {
  it("притягивает все кристаллы на поле, и дальние тоже", () => {
    const world = setup();
    spawnGem(world, world.player.x + 150, world.player.y, 1);
    spawnGem(world, world.player.x + 900, world.player.y, 3);
    const [near, far] = [0, 1];
    spawnPickup(world, PICKUP_KIND.magnet, world.player.x, world.player.y);
    land(world);

    updatePickups(world);

    expect(world.gems.attracted[near]).toBe(1);
    expect(world.gems.attracted[far]).toBe(1);
    expect(world.stats.magnetsCollected).toBe(1);
    expect(lastEvent(world).kind).toBe(SIM_EVENT.magnet);
  });

  it("подбирается и с полным здоровьем — это не лечение", () => {
    const world = setup();
    spawnPickup(world, PICKUP_KIND.magnet, world.player.x, world.player.y);
    land(world);
    updatePickups(world);
    expect(world.pickups.aliveCount).toBe(0);
  });
});

describe("динамит", () => {
  function detonateNear(world: World): void {
    spawnPickup(world, PICKUP_KIND.dynamite, world.player.x, world.player.y);
    land(world);
    updatePickups(world);
  }

  it("выкашивает рядовых в радиусе и засчитывает их как убийства", () => {
    const world = setup();
    const inside = spawnEnemy(world, 0, world.player.x + 150, world.player.y);
    const outside = spawnEnemy(world, 0, world.player.x + 260, world.player.y);

    detonateNear(world);

    expect(world.enemies.alive[inside]).toBe(0);
    expect(world.enemies.alive[outside]).toBe(1);
    expect(world.stats.enemiesKilled).toBe(1);
    expect(world.stats.dynamiteCollected).toBe(1);
    expect(lastEvent(world).kind).toBe(SIM_EVENT.dynamite);
    expect(lastEvent(world).radius).toBe(200);
  });

  it("элиту не убивает, а снимает долю базового здоровья", () => {
    const world = setup();
    const boss = spawnEnemy(world, 1, world.player.x + 50, world.player.y);

    detonateNear(world);
    expect(world.enemies.alive[boss]).toBe(1);
    expect(world.enemies.hp[boss]).toBeCloseTo(70, 6);

    // Даже почти добитую элиту взрыв оставляет живой — добивать игроку.
    world.enemies.hp[boss] = 5;
    detonateNear(world);
    expect(world.enemies.alive[boss]).toBe(1);
    expect(world.enemies.hp[boss]).toBe(1);
  });

  it("не пишет свой урон в урон по оружиям — таблица баланса оружий остаётся честной", () => {
    const world = setup();
    spawnEnemy(world, 0, world.player.x + 50, world.player.y);
    detonateNear(world);
    expect(world.stats.damageDealt).toBe(0);
  });

  it("потомки делящегося, появившиеся от взрыва, взрыв переживают", () => {
    const world = setup();
    spawnEnemy(world, 2, world.player.x + 50, world.player.y);
    detonateNear(world);

    expect(world.stats.enemiesKilled).toBe(1);
    expect(world.enemies.aliveCount).toBe(2);
  });
});

describe("контент подборов", () => {
  it("боевой контент корректен", () => {
    expect(findPickupContentProblems(DROPS)).toEqual([]);
  });

  it("называет поле с ошибкой", () => {
    const problems = findPickupContentProblems(
      drops({
        medkits: { chance: 2, eliteChance: -1, healRatio: 0, maxOnField: 99 },
        dynamite: { chance: 0, eliteChance: 0, maxOnField: 1, radiusUnits: 0, eliteHpRatio: 1 },
      }),
    );
    expect(problems).toHaveLength(6);
    expect(problems.join("\n")).toMatch(/eliteHpRatio/);
  });

  it("вид подбора на канве и в гайдбуке совпадает с видом в симуляции", () => {
    // Рендер берёт вид по индексу вида из симуляции: перестановка строк
    // превратила бы аптечку в динамит на земле.
    for (const [id, kind] of Object.entries(PICKUP_KIND)) {
      expect(PICKUP_LOOKS[kind]?.id, id).toBe(id);
    }
    expect(PICKUP_LOOKS).toHaveLength(Object.keys(PICKUP_KIND).length);
  });
});
