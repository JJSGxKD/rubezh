import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { DASH_PHASE, EXPLODER_PHASE } from "../src/game/patterns";
import { SIM_EVENT } from "../src/game/sim/events";
import { stepWorld, IDLE_INPUT } from "../src/game/sim/step";
import { vectorLength } from "../src/game/sim/vector";
import {
  createWorld,
  DEFAULT_SIM_CONFIG,
  NO_OWNER_TYPE,
  spawnEnemy,
  TICK_SEC,
  type PlayerConfig,
  type World,
} from "../src/game/sim/world";

// Поведение паттернов врагов (docs/26-stage2-plan.md, WP1). Каждый тест
// проверяет то, ради чего паттерн существует для игрока, а не внутреннюю
// реализацию: «рывок нельзя начать до конца телеграфа», а не «фаза равна 2».

const FIXTURES: EnemyDef[] = [
  { id: "t_swarm", hp: 10, speed: 100, damage: 1, pattern: "swarm" },
  { id: "t_chase", hp: 10, speed: 100, damage: 1, pattern: "chase" },
  {
    id: "t_kite",
    hp: 10,
    speed: 60,
    damage: 2,
    pattern: "kite_and_shoot",
    params: { preferredDistance: 200, shotIntervalSec: 0.5, projectileSpeed: 300 },
  },
  {
    id: "t_dash",
    hp: 10,
    speed: 60,
    damage: 3,
    pattern: "dash",
    params: { triggerDistance: 150, telegraphSec: 0.5, dashSpeed: 600, dashDurationSec: 0.3, recoverSec: 0.5 },
  },
  {
    id: "t_orbit",
    hp: 10,
    speed: 120,
    damage: 1,
    pattern: "orbit",
    params: { orbitRadius: 150, shrinkPerSec: 20, minRadius: 50 },
  },
  {
    id: "t_exploder",
    hp: 10,
    speed: 80,
    damage: 25,
    pattern: "exploder",
    params: { triggerDistance: 60, fuseSec: 0.5, blastRadius: 80 },
  },
  {
    id: "t_exploder_fragile",
    hp: 1,
    speed: 80,
    damage: 25,
    pattern: "exploder",
    params: { triggerDistance: 60, fuseSec: 0.5, blastRadius: 80 },
  },
  {
    id: "t_splitter",
    hp: 1,
    speed: 40,
    damage: 1,
    pattern: "splitter",
    params: { childEnemy: "t_swarm", childCount: 3 },
  },
];

const CENTER = 1000;

interface SetupOptions {
  seed?: number;
  /** стреляет ли игрок: в большинстве тестов атака мешает — убивает подопытного */
  playerAttacks?: boolean;
  maxHp?: number;
  maxEnemies?: number;
}

function setup(options: SetupOptions = {}): World {
  const player: PlayerConfig = {
    ...DEFAULT_SIM_CONFIG.player,
    maxHp: options.maxHp ?? 1_000_000,
    attackRangePx: options.playerAttacks === true ? DEFAULT_SIM_CONFIG.player.attackRangePx : 0,
  };
  return createWorld({
    seed: options.seed ?? 1,
    enemies: FIXTURES,
    config: { width: CENTER * 2, height: CENTER * 2, maxEnemies: options.maxEnemies ?? 512, player },
  });
}

function typeIndex(world: World, id: string): number {
  const index = world.enemyTypes.findIndex((type) => type.id === id);
  if (index < 0) throw new Error(`Нет фикстуры ${id}`);
  return index;
}

function place(world: World, id: string, dx: number, dy: number): number {
  const slot = spawnEnemy(world, typeIndex(world, id), CENTER + dx, CENTER + dy);
  if (slot < 0) throw new Error("Пул исчерпан при подготовке теста");
  return slot;
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

function distanceToPlayer(world: World, slot: number): number {
  return vectorLength(world.enemies.x[slot] - world.player.x, world.enemies.y[slot] - world.player.y);
}

function speedOf(world: World, slot: number): number {
  return vectorLength(world.enemies.vx[slot], world.enemies.vy[slot]);
}

function teleportPlayer(world: World, x: number, y: number): void {
  world.player.x = x;
  world.player.y = y;
  world.player.prevX = x;
  world.player.prevY = y;
}

function aliveOfType(world: World, id: string): number[] {
  const wanted = typeIndex(world, id);
  const slots: number[] = [];
  for (let i = 0; i < world.enemies.count; i++) {
    if (world.enemies.alive[i] === 1 && world.enemies.type[i] === wanted) slots.push(i);
  }
  return slots;
}

describe("рой", () => {
  it("идёт на игрока по прямой на полной скорости", () => {
    const world = setup();
    const slot = place(world, "t_swarm", 300, 0);

    run(world, 30);

    expect(distanceToPlayer(world, slot)).toBeCloseTo(300 - 100 * 30 * TICK_SEC, 1);
    expect(world.enemies.y[slot]).toBeCloseTo(CENTER, 3);
  });
});

describe("преследование", () => {
  it("набирает скорость с инерцией, а не мгновенно", () => {
    const world = setup();
    const slot = place(world, "t_chase", 600, 0);

    run(world, 1);
    expect(speedOf(world, slot)).toBeGreaterThan(0);
    expect(speedOf(world, slot)).toBeLessThan(100);

    run(world, 180);
    expect(speedOf(world, slot)).toBeCloseTo(100, 0);
  });
});

describe("стрелок", () => {
  it("выходит на заданную дистанцию и держит её", () => {
    const world = setup();
    const slot = place(world, "t_kite", 600, 0);

    run(world, 600);

    const distance = distanceToPlayer(world, slot);
    expect(distance).toBeGreaterThan(200 - 24 - 2);
    expect(distance).toBeLessThan(200 + 24 + 2);
  });

  it("не бьёт касанием, а рой в той же точке бьёт — решает возможность паттерна", () => {
    const kiteWorld = setup();
    place(kiteWorld, "t_kite", 0, 0);
    run(kiteWorld, 60);

    const swarmWorld = setup();
    place(swarmWorld, "t_swarm", 0, 0);
    run(swarmWorld, 60);

    expect(kiteWorld.stats.damageTaken).toBe(0);
    expect(swarmWorld.stats.damageTaken).toBeGreaterThan(0);
  });

  it("помечает снаряд своим типом, и смерть от него засчитывается стрелку", () => {
    const world = setup({ maxHp: 1 });
    place(world, "t_kite", 200, 0);

    run(world, 1);
    const ownProjectile = Array.from({ length: world.projectiles.count }, (_, p) => p).find(
      (p) => world.projectiles.alive[p] === 1 && world.projectiles.fromPlayer[p] === 0,
    );
    expect(ownProjectile).toBeDefined();
    expect(world.projectiles.ownerType[ownProjectile ?? 0]).toBe(typeIndex(world, "t_kite"));

    run(world, 120);
    expect(world.player.alive).toBe(false);
    expect(world.stats.deathCauseType).toBe(typeIndex(world, "t_kite"));
  });
});

describe("рывок", () => {
  it("стоит на месте весь телеграф и срывается только после него", () => {
    const world = setup();
    const slot = place(world, "t_dash", 100, 0);
    const startX = world.enemies.x[slot];

    run(world, 28);
    expect(world.enemies.phase[slot]).toBe(DASH_PHASE.telegraph);
    expect(world.enemies.x[slot]).toBeCloseTo(startX, 5);

    // За десяток тиков рывка на 600 ед/с враг проходит порядка сотни единиц,
    // а шагом сближения на 60 ед/с — меньше десяти.
    run(world, 12);
    expect(startX - world.enemies.x[slot]).toBeGreaterThan(60);
  });

  it("фиксирует направление в начале телеграфа — от рывка можно уйти вбок", () => {
    const world = setup();
    const slot = place(world, "t_dash", 100, 0);

    run(world, 1);
    teleportPlayer(world, CENTER, CENTER + 200);
    run(world, 45);

    expect(world.enemies.y[slot]).toBeCloseTo(CENTER, 3);
    expect(world.enemies.x[slot]).toBeLessThan(CENTER);
  });

  it("проходит весь цикл: сближение, телеграф, рывок, отдых и снова сближение", () => {
    const world = setup();
    const slot = place(world, "t_dash", 400, 0);
    const seen: number[] = [];

    // Сближение с 400 до 150 на 60 ед/с — около четырёх секунд, плюс телеграф,
    // рывок и отдых: десяти секунд хватает с запасом.
    for (let i = 0; i < 600; i++) {
      stepWorld(world, IDLE_INPUT);
      const phase = world.enemies.phase[slot];
      if (seen[seen.length - 1] !== phase) seen.push(phase);
    }

    expect(seen.slice(0, 5)).toEqual([
      DASH_PHASE.approach,
      DASH_PHASE.telegraph,
      DASH_PHASE.dash,
      DASH_PHASE.recover,
      DASH_PHASE.approach,
    ]);
  });
});

describe("кружащий", () => {
  it("вращается вокруг игрока в одну сторону", () => {
    const world = setup();
    const slot = place(world, "t_orbit", 150, 0);
    const crossSigns = new Set<number>();

    let prevX = world.enemies.x[slot] - world.player.x;
    let prevY = world.enemies.y[slot] - world.player.y;
    for (let sample = 0; sample < 12; sample++) {
      run(world, 10);
      const x = world.enemies.x[slot] - world.player.x;
      const y = world.enemies.y[slot] - world.player.y;
      crossSigns.add(Math.sign(prevX * y - prevY * x));
      prevX = x;
      prevY = y;
    }

    expect(crossSigns.size).toBe(1);
    expect(crossSigns.has(0)).toBe(false);
  });

  it("сужает кольцо до minRadius, но не ниже", () => {
    const world = setup();
    const slot = place(world, "t_orbit", 150, 0);

    run(world, 60);
    const early = distanceToPlayer(world, slot);
    run(world, 60 * 20);

    expect(world.enemies.ringRadius[slot]).toBeCloseTo(50, 3);
    expect(distanceToPlayer(world, slot)).toBeLessThan(early);
    expect(distanceToPlayer(world, slot)).toBeGreaterThan(50 - 30);
  });

  it("выбирает направление вращения генератором мира — одинаково на одном seed", () => {
    const spins = [setup({ seed: 7 }), setup({ seed: 7 })].map((world) => {
      const slot = place(world, "t_orbit", 150, 0);
      run(world, 1);
      return world.enemies.dirX[slot];
    });

    expect(Math.abs(spins[0] ?? 0)).toBe(1);
    expect(spins[1]).toBe(spins[0]);
  });
});

describe("подрывник", () => {
  it("не бьёт касанием и взрывается только после фитиля", () => {
    const world = setup();
    const slot = place(world, "t_exploder", 0, 0);

    run(world, 25);
    expect(world.enemies.phase[slot]).toBe(EXPLODER_PHASE.fuse);
    expect(world.stats.damageTaken).toBe(0);

    run(world, 15);
    expect(world.stats.damageTaken).toBe(25);
    expect(world.enemies.alive[slot]).toBe(0);
  });

  it("сообщает рендеру о взрыве и не засчитывает игроку убийство", () => {
    const world = setup();
    place(world, "t_exploder", 30, 0);

    run(world, 40);

    expect(world.events.written).toBe(1);
    expect(world.events.kind[0]).toBe(SIM_EVENT.explosion);
    expect(world.events.radius[0]).toBeCloseTo(80, 3);
    expect(world.stats.enemiesKilled).toBe(0);
  });

  it("не задевает игрока, успевшего выйти из радиуса за время фитиля", () => {
    const world = setup();
    place(world, "t_exploder", 50, 0);

    run(world, 1);
    teleportPlayer(world, CENTER - 300, CENTER);
    run(world, 40);

    expect(world.events.written).toBe(1);
    expect(world.stats.damageTaken).toBe(0);
  });

  it("убитый во время фитиля не взрывается", () => {
    const world = setup({ playerAttacks: true });
    place(world, "t_exploder_fragile", 50, 0);

    run(world, 60);

    expect(world.stats.enemiesKilled).toBe(1);
    expect(world.events.written).toBe(0);
    expect(world.stats.damageTaken).toBe(0);
  });
});

describe("делящийся", () => {
  function killSplitter(world: World, slot: number): { x: number; y: number } {
    for (let i = 0; i < 120; i++) {
      const lastX = world.enemies.x[slot];
      const lastY = world.enemies.y[slot];
      stepWorld(world, IDLE_INPUT);
      if (world.stats.killsByType[typeIndex(world, "t_splitter")] === 1) return { x: lastX, y: lastY };
    }
    throw new Error("Делящийся не погиб за две секунды");
  }

  it("распадается ровно на заданное число потомков", () => {
    const world = setup({ playerAttacks: true });
    const slot = place(world, "t_splitter", 100, 0);

    killSplitter(world, slot);

    expect(aliveOfType(world, "t_swarm")).toHaveLength(3);
    expect(world.stats.enemiesSpawned).toBe(4);
  });

  it("ставит потомков рядом с местом гибели", () => {
    const world = setup({ playerAttacks: true });
    const slot = place(world, "t_splitter", 100, 0);

    const origin = killSplitter(world, slot);

    for (const child of aliveOfType(world, "t_swarm")) {
      const distance = vectorLength(world.enemies.x[child] - origin.x, world.enemies.y[child] - origin.y);
      expect(distance).toBeLessThan(14 + 1);
    }
  });

  it("при исчерпании пула не падает и не выходит за ёмкость", () => {
    const world = setup({ playerAttacks: true, maxEnemies: 2 });
    const slot = place(world, "t_splitter", 100, 0);
    place(world, "t_swarm", 900, 0);

    killSplitter(world, slot);

    expect(world.enemies.aliveCount).toBeLessThanOrEqual(2);
    expect(aliveOfType(world, "t_swarm").length).toBeGreaterThanOrEqual(1);
  });

  it("раскладывает потомков одинаково на одном seed", () => {
    const positions = [setup({ playerAttacks: true }), setup({ playerAttacks: true })].map((world) => {
      killSplitter(world, place(world, "t_splitter", 100, 0));
      return aliveOfType(world, "t_swarm").map((child) => [world.enemies.x[child], world.enemies.y[child]]);
    });

    expect(positions[1]).toEqual(positions[0]);
  });
});

describe("статистика врагов", () => {
  it("считает убийства по типам", () => {
    const world = setup({ playerAttacks: true });
    place(world, "t_swarm", 150, 0);
    place(world, "t_swarm", -150, 0);

    run(world, 120);

    expect(world.stats.killsByType[typeIndex(world, "t_swarm")]).toBe(2);
    expect(world.stats.killsByType[typeIndex(world, "t_chase")]).toBe(0);
  });

  it("не путает снаряд игрока с вражеским: владелец сбрасывается при повторном использовании слота", () => {
    const world = setup({ playerAttacks: true });
    place(world, "t_kite", 200, 0);

    run(world, 240);

    for (let p = 0; p < world.projectiles.count; p++) {
      if (world.projectiles.alive[p] === 0 || world.projectiles.fromPlayer[p] === 0) continue;
      expect(world.projectiles.ownerType[p]).toBe(NO_OWNER_TYPE);
    }
  });
});
