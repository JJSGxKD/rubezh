import type { DropsDef, EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { applyDevCommand } from "../src/game/run/dev-commands";
import { applyContinue } from "../src/game/sim/continue";
import { damagePlayer, createWorld, spawnEnemy, TICK_SEC, type World } from "../src/game/sim/world";
import { checksumWorld } from "../src/game/sim/checksum";
import { killEnemy } from "../src/game/sim/combat";
import { SIM_EVENT } from "../src/game/sim/events";
import { PICKUP_KIND, PICKUP_LAND_TICKS, countOnField, rollPickups, spawnPickup, updatePickups } from "../src/game/sim/pickups";
import { IDLE_INPUT, stepWorld } from "../src/game/sim/step";
import { startFreeze } from "../src/game/sim/freeze";

// Подбор «Заморозка» (tasks/T-0116): общий таймер мира останавливает всех
// живых врагов, не лечит горение и яд, не съедается паузой. Проверяется то,
// ради чего подбор нужен игроку: орда стоит, а потом идёт снова.

const RAT: EnemyDef = { id: "rat", hp: 10, speed: 60, damage: 4, xp: 1, pattern: "swarm" };
const ELITE: EnemyDef = { id: "elite", hp: 50, speed: 60, damage: 4, xp: 1, pattern: "swarm", rank: "elite" };
const BOSS: EnemyDef = { id: "boss", hp: 500, speed: 60, damage: 4, xp: 1, pattern: "swarm", rank: "boss" };
const DASHER: EnemyDef = {
  id: "dasher",
  hp: 10,
  speed: 60,
  damage: 3,
  xp: 1,
  pattern: "dash",
  params: { triggerDistance: 150, telegraphSec: 0.5, dashSpeed: 600, dashDurationSec: 0.3, recoverSec: 0.5 },
};
const BOMBER: EnemyDef = {
  id: "bomber",
  hp: 10,
  speed: 80,
  damage: 25,
  xp: 1,
  pattern: "exploder",
  params: { triggerDistance: 60, fuseSec: 0.5, blastRadius: 80 },
};
const SLIME: EnemyDef = {
  id: "slime",
  hp: 10,
  speed: 60,
  damage: 1,
  xp: 1,
  pattern: "splitter",
  params: { children: [{ enemy: "rat", count: 2 }] },
};

const DURATION_SEC = 10;
const BOSS_RATIO = 0.5;
const TOTAL_TICKS = Math.round(DURATION_SEC / TICK_SEC);

function drops(patch: Partial<DropsDef> = {}): DropsDef {
  return {
    gems: { maxPerKill: 1 },
    medkits: { chance: 0, eliteChance: 0, healRatio: 0.3, maxOnField: 0 },
    magnets: { chance: 0, eliteChance: 0, maxOnField: 0 },
    dynamite: { chance: 0, eliteChance: 0, maxOnField: 0, radiusUnits: 200, eliteHpRatio: 0.3 },
    freeze: { chance: 0, eliteChance: 0, maxOnField: 1, durationSec: DURATION_SEC, bossDurationRatio: BOSS_RATIO },
    ...patch,
  };
}

function setup(seed = 1): World {
  return createWorld({
    seed,
    enemies: [RAT, ELITE, BOSS, DASHER, BOMBER, SLIME],
    drops: drops(),
    config: { progressionEnabled: false, player: { ...createWorld({ seed: 1, enemies: [RAT] }).config.player, maxHp: 1_000_000 } },
  });
}

function typeOf(world: World, id: string): number {
  return world.enemyTypes.findIndex((type) => type.id === id);
}

function place(world: World, id: string, x: number, y: number): number {
  const slot = spawnEnemy(world, typeOf(world, id), x, y);
  if (slot < 0) throw new Error("Пул исчерпан при подготовке теста");
  return slot;
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

describe("заморозка: таймер мира", () => {
  it("рой не двигается, пока таймер идёт, и идёт после него", () => {
    const world = setup();
    const slot = place(world, "rat", 300, 0);
    startFreeze(world);

    run(world, TOTAL_TICKS - 1);
    expect(world.enemies.x[slot]).toBe(300);
    expect(world.enemies.y[slot]).toBe(0);

    run(world, 2);
    run(world, 30);
    expect(world.enemies.x[slot]).toBeLessThan(300);
  });

  it("враг вплотную не бьёт, пока заморожен, и бьёт после", () => {
    const world = setup();
    place(world, "rat", 5, 0);
    startFreeze(world);

    run(world, TOTAL_TICKS - 1);
    expect(world.stats.damageTaken).toBe(0);

    run(world, 5);
    expect(world.stats.damageTaken).toBeGreaterThan(0);
  });

  it("не ведёт телеграф рывка и фитиль подрывника: таймеры паттернов стоят", () => {
    const world = setup();
    const dasher = place(world, "dasher", 120, 0);
    const bomber = place(world, "bomber", 50, 0);
    run(world, 2);
    const dashPhase = world.enemies.phase[dasher];
    const bomberPhase = world.enemies.phase[bomber];
    const dashTimer = world.enemies.timer[dasher];
    const bomberTimer = world.enemies.timer[bomber];

    startFreeze(world);
    run(world, TOTAL_TICKS - 1);

    expect(world.enemies.phase[dasher]).toBe(dashPhase);
    expect(world.enemies.timer[dasher]).toBe(dashTimer);
    expect(world.enemies.phase[bomber]).toBe(bomberPhase);
    expect(world.enemies.timer[bomber]).toBe(bomberTimer);
    expect(world.enemies.alive[bomber]).toBe(1);
  });

  it("горение и яд тикают: заморозка не лечит", () => {
    const world = setup();
    const burning = place(world, "elite", 300, 0);
    const poisoned = place(world, "rat", 300, 100);
    world.enemies.burnTimer[burning] = 3;
    world.enemies.burnDps[burning] = 2;
    world.enemies.poisonTimer[poisoned] = 3;
    world.enemies.poisonDps[poisoned] = 1;
    world.enemies.poisonStacks[poisoned] = 2;
    const before = world.enemies.hp[burning];
    startFreeze(world);

    run(world, 120);

    expect(world.enemies.hp[burning]).toBeLessThan(before);
    expect(world.enemies.hp[poisoned]).toBeLessThan(10);
    expect(world.enemies.x[burning]).toBe(300);
  });

  it("рядовой и элита стоят весь срок, босс — долю срока", () => {
    const world = setup();
    const rat = place(world, "rat", 400, 0);
    const elite = place(world, "elite", 400, 100);
    const boss = place(world, "boss", 400, -100);
    startFreeze(world);

    const bossTicks = Math.floor(TOTAL_TICKS * BOSS_RATIO);
    run(world, bossTicks - 1);
    expect(world.enemies.x[boss]).toBe(400);

    run(world, 10);
    expect(world.enemies.x[boss]).toBeLessThan(400);
    expect(world.enemies.x[rat]).toBe(400);
    expect(world.enemies.x[elite]).toBe(400);

    run(world, TOTAL_TICKS - bossTicks - 10 - 1);
    expect(world.enemies.x[rat]).toBe(400);
    expect(world.enemies.x[elite]).toBe(400);
  });

  it("родившийся во время заморозки стоит до общего конца", () => {
    const world = setup();
    startFreeze(world);
    run(world, 60);

    const born = place(world, "rat", 300, 0);
    run(world, TOTAL_TICKS - 61);
    expect(world.enemies.x[born]).toBe(300);

    run(world, 30);
    expect(world.enemies.x[born]).toBeLessThan(300);
  });

  it("потомки делящегося, погибшего в заморозке, тоже стоят", () => {
    const world = setup();
    const slime = place(world, "slime", 300, 0);
    startFreeze(world);
    killEnemy(world, slime);

    const children: number[] = [];
    for (let i = 0; i < world.enemies.count; i++) if (world.enemies.alive[i] === 1) children.push(i);
    expect(children).toHaveLength(2);
    const startX = children.map((i) => world.enemies.x[i]);

    run(world, 60);
    children.forEach((slot, k) => expect(world.enemies.x[slot]).toBe(startX[k]));
  });

  it("вражеский снаряд в полёте не замирает", () => {
    const world = setup();
    startFreeze(world);
    const slot = world.projectiles.alive.indexOf(0);
    world.projectiles.alive[slot] = 1;
    world.projectiles.count = slot + 1;
    world.projectiles.fromPlayer[slot] = 0;
    world.projectiles.x[slot] = 200;
    world.projectiles.y[slot] = 0;
    world.projectiles.vx[slot] = -100;
    world.projectiles.vy[slot] = 0;
    world.projectiles.ttl[slot] = 5;
    world.projectiles.damage[slot] = 1;

    run(world, 10);
    expect(world.projectiles.x[slot]).toBeLessThan(200);
  });

  it("пауза выбора улучшения таймер не съедает: мир стоит целиком", () => {
    const world = setup();
    startFreeze(world);
    run(world, 10);
    const left = world.stats.freezeTicks;

    // Окно выбора открыто, пока есть варианты: содержимое шагу мира не важно.
    world.progression.offers = [{}] as never;
    run(world, 120);
    expect(world.stats.freezeTicks).toBe(left);
  });

  it("второй шанс обнуляет заморозку", () => {
    const world = createWorld({
      seed: 1,
      enemies: [RAT],
      drops: drops(),
      continueRules: { perRun: 1, restoreHpRatio: 0.5, invulnerableSec: 1 },
      config: { progressionEnabled: false },
    });
    startFreeze(world);
    damagePlayer(world, world.player.hp + 1000, 0);

    expect(applyContinue(world)).toBe(true);
    expect(world.stats.freezeTicks).toBe(0);
  });

  it("повторный подбор возвращает полный срок, а не суммирует", () => {
    const world = setup();
    startFreeze(world);
    run(world, 200);
    expect(world.stats.freezeTicks).toBe(TOTAL_TICKS - 200);

    startFreeze(world);
    expect(world.stats.freezeTicks).toBe(TOTAL_TICKS);
    expect(world.stats.freezeTotalTicks).toBe(TOTAL_TICKS);
  });
});

describe("заморозка: подбор", () => {
  it("падает с рядового и элиты по своим шансам", () => {
    const world = createWorld({
      seed: 1,
      enemies: [RAT, ELITE],
      drops: drops({ freeze: { chance: 0, eliteChance: 1, maxOnField: 1, durationSec: DURATION_SEC, bossDurationRatio: BOSS_RATIO } }),
    });
    killEnemy(world, spawnEnemy(world, 0, 100, 0));
    expect(countOnField(world, PICKUP_KIND.freeze)).toBe(0);

    killEnemy(world, spawnEnemy(world, 1, 100, 0));
    expect(countOnField(world, PICKUP_KIND.freeze)).toBe(1);
  });

  it("не больше одной на поле", () => {
    const world = createWorld({
      seed: 1,
      enemies: [RAT],
      drops: drops({ freeze: { chance: 1, eliteChance: 1, maxOnField: 1, durationSec: DURATION_SEC, bossDurationRatio: BOSS_RATIO } }),
    });
    for (let k = 0; k < 5; k++) rollPickups(world, 0, 0, false);
    expect(countOnField(world, PICKUP_KIND.freeze)).toBe(1);
  });

  it("касание подбирает: ставит таймер, пишет событие и считает подобранное", () => {
    const world = setup();
    spawnPickup(world, PICKUP_KIND.freeze, 0, 0);
    world.stats.tick += PICKUP_LAND_TICKS;

    updatePickups(world);

    expect(world.pickups.aliveCount).toBe(0);
    expect(world.stats.freezeTicks).toBe(TOTAL_TICKS);
    expect(world.stats.freezeCollected).toBe(1);
    const slot = (world.events.written - 1) % world.events.kind.length;
    expect(world.events.kind[slot]).toBe(SIM_EVENT.freeze);
    expect(world.events.radius[slot]).toBeCloseTo(world.config.view.spawnRadius, 3);
  });

  it("подбирается и с полным здоровьем: это не лечение", () => {
    const world = setup();
    spawnPickup(world, PICKUP_KIND.freeze, 0, 0);
    world.stats.tick += PICKUP_LAND_TICKS;
    expect(world.player.hp).toBe(world.playerStats.maxHp);

    updatePickups(world);
    expect(world.stats.freezeCollected).toBe(1);
  });

  it("при нулевых шансах генератор не вызывается, и последовательность прежняя", () => {
    const withFreeze = setup(5);
    const without = createWorld({ seed: 5, enemies: [RAT, ELITE, BOSS, DASHER, BOMBER, SLIME], drops: drops() });
    for (let k = 0; k < 20; k++) {
      rollPickups(withFreeze, 0, 0, false);
      rollPickups(without, 0, 0, true);
    }
    expect(withFreeze.rng.getState()).toBe(createWorld({ seed: 5, enemies: [RAT], drops: drops() }).rng.getState());
  });

  it("команда разработчика ставит заморозку на поле", () => {
    const world = setup();
    applyDevCommand(world, { kind: "spawnPickup", pickup: "freeze" });
    expect(countOnField(world, PICKUP_KIND.freeze)).toBe(1);
  });
});

describe("заморозка: повторяемость", () => {
  it("один seed и сценарий дают одну контрольную сумму дважды", () => {
    const scenario = (): number => {
      const world = setup(42);
      for (let k = 0; k < 6; k++) place(world, "rat", 200 + k * 20, 40 * k - 100);
      run(world, 30);
      startFreeze(world);
      run(world, 240);
      return checksumWorld(world);
    };
    expect(scenario()).toBe(scenario());
  });
});
