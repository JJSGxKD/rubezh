import type { EnemyDef, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { BLINK_PHASE } from "../src/game/patterns";
import { findEnemyContentProblems } from "../src/game/patterns/enemy-types";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { checksumWorld } from "../src/game/sim/checksum";
import type { Spawner } from "../src/game/sim/spawner";
import { IDLE_INPUT, stepWorld, type SimInput } from "../src/game/sim/step";
import { findNearestEnemy } from "../src/game/weapons/shooting";
import { createWorld, DEFAULT_SIM_CONFIG, spawnEnemy, TICK_HZ, type World } from "../src/game/sim/world";

/**
 * Паттерн `blink` (Р157, T-0283): враг подходит, тает, исчезает и появляется рядом с игроком
 * на месте, которое заранее отмечено меткой. Цикл — `chase` → `fading` → `hidden` → `appear`.
 */

const EVERY_SEC = 4;
const TELEGRAPH_SEC = 0.6;
const DISTANCE = 90;
const FADE_TICKS = Math.round(0.25 * TICK_HZ);
const HIDDEN_TICKS = Math.round(TELEGRAPH_SEC * TICK_HZ);

/** Враг почти стоит: до игрока он не дойдёт и касанием не помешает считать фазы. */
const BLINKER: EnemyDef = {
  id: "blinker",
  hp: 100_000,
  speed: 5,
  damage: 10,
  xp: 1,
  pattern: "blink",
  params: { blinkEverySec: EVERY_SEC, telegraphSec: TELEGRAPH_SEC, blinkDistance: DISTANCE },
};

const AURA: WeaponDef = {
  id: "aura",
  behavior: "aura",
  nameKey: "n",
  descriptionKey: "d",
  levels: [{ damage: 5, cooldownSec: 0.1, areaRadius: 300 }],
};

const NO_SPAWNER: Spawner = { update: () => undefined };
const FAR = 300;
const RIGHT: SimInput = { moveX: 1, moveY: 0 };

function setup(seed = 5, config: Partial<typeof DEFAULT_SIM_CONFIG> = {}, weapons: WeaponDef[] = []): World {
  return createWorld({
    seed,
    enemies: [BLINKER],
    weapons,
    config: { progressionEnabled: false, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1000 }, ...config },
  });
}

function spawn(world: World, x = FAR, y = 0): number {
  const slot = spawnEnemy(world, 0, x, y);
  if (slot < 0) throw new Error("пул исчерпан");
  return slot;
}

/** Шагает, пока фаза врага не станет нужной; возвращает, сколько тиков это заняло. */
function ticksUntil(world: World, slot: number, phase: number, input: SimInput = IDLE_INPUT, limit = 1000): number {
  for (let ticks = 1; ticks <= limit; ticks++) {
    stepWorld(world, input);
    if (world.enemies.phase[slot] === phase) return ticks;
  }
  throw new Error(`фаза ${phase} не наступила за ${limit} тиков`);
}

function distanceToPlayer(world: World, slot: number): number {
  return Math.hypot(world.enemies.x[slot] - world.player.x, world.enemies.y[slot] - world.player.y);
}

describe("цикл фаз blink", () => {
  it("chase blinkEverySec, потом fading 0,25 с, hidden telegraphSec, appear и снова chase", () => {
    const world = setup();
    const slot = spawn(world);
    expect(world.enemies.phase[slot]).toBe(BLINK_PHASE.chase);

    const chase = ticksUntil(world, slot, BLINK_PHASE.fading);
    expect(Math.abs(chase - EVERY_SEC * TICK_HZ)).toBeLessThanOrEqual(1);

    const fading = ticksUntil(world, slot, BLINK_PHASE.hidden);
    expect(Math.abs(fading - FADE_TICKS)).toBeLessThanOrEqual(1);

    const hidden = ticksUntil(world, slot, BLINK_PHASE.appear);
    expect(Math.abs(hidden - HIDDEN_TICKS)).toBeLessThanOrEqual(1);

    ticksUntil(world, slot, BLINK_PHASE.chase);
    // Цикл замкнулся: следующее исчезновение — снова через blinkEverySec.
    const again = ticksUntil(world, slot, BLINK_PHASE.fading);
    expect(Math.abs(again - EVERY_SEC * TICK_HZ)).toBeLessThanOrEqual(1);
  });

  it("в fading враг стоит на месте и тает, а в chase идёт на игрока", () => {
    const world = setup();
    const slot = spawn(world);
    stepWorld(world, IDLE_INPUT);
    expect(world.enemies.vx[slot]).toBeLessThan(0);

    ticksUntil(world, slot, BLINK_PHASE.fading);
    stepWorld(world, IDLE_INPUT);
    expect(world.enemies.vx[slot]).toBe(0);
    expect(world.enemies.vy[slot]).toBe(0);
  });
});

describe("скрытый враг", () => {
  it("в hidden не цель оружия: выпадает из сетки и не находится как ближний", () => {
    const world = setup();
    const slot = spawn(world);
    ticksUntil(world, slot, BLINK_PHASE.fading);
    // В fading его ещё можно бить: он тает, но стоит на месте.
    stepWorld(world, IDLE_INPUT);
    expect(findNearestEnemy(world, world.enemies.x[slot], world.enemies.y[slot], 50)).toBe(slot);

    ticksUntil(world, slot, BLINK_PHASE.hidden);
    const x = world.enemies.x[slot];
    const y = world.enemies.y[slot];
    expect(findNearestEnemy(world, x, y, 500)).toBe(-1);
    const found = world.enemyGrid.queryInto(x, y, 500, world.queryBuffer);
    expect([...world.queryBuffer.subarray(0, found)]).not.toContain(slot);

    // Скрытый остаётся живым: он занимает место в пуле и в бюджете живых.
    expect(world.enemies.alive[slot]).toBe(1);
    expect(world.enemies.aliveCount).toBe(1);
  });

  it("в hidden оружие по нему не бьёт, а в chase бьёт", () => {
    const world = setup(5, {}, [AURA]);
    const slot = spawn(world, 200, 0);
    const before = world.enemies.hp[slot];
    stepWorld(world, IDLE_INPUT);
    expect(world.enemies.hp[slot]).toBeLessThan(before);

    ticksUntil(world, slot, BLINK_PHASE.hidden);
    const hidden = world.enemies.hp[slot];
    for (let i = 0; i < HIDDEN_TICKS - 3; i++) stepWorld(world, IDLE_INPUT);
    expect(world.enemies.phase[slot]).toBe(BLINK_PHASE.hidden);
    expect(world.enemies.hp[slot]).toBe(hidden);
  });

  it("враг в hidden не бьёт касанием, в chase бьёт", () => {
    const world = setup();
    const slot = spawn(world, 12, 0);
    stepWorld(world, IDLE_INPUT);
    expect(world.player.hp).toBeLessThan(1000);

    ticksUntil(world, slot, BLINK_PHASE.hidden);
    // Игрока ставят прямо на метку: касание должно было бы бить.
    world.player.x = world.enemies.x[slot];
    world.player.y = world.enemies.y[slot];
    world.player.hp = 1000;
    for (let i = 0; i < HIDDEN_TICKS - 3; i++) stepWorld(world, IDLE_INPUT);
    expect(world.enemies.phase[slot]).toBe(BLINK_PHASE.hidden);
    expect(world.player.hp).toBe(1000);
  });

  it("в fading и appear касание не бьёт: урон только в chase", () => {
    const world = setup();
    const slot = spawn(world);
    ticksUntil(world, slot, BLINK_PHASE.fading);
    world.player.x = world.enemies.x[slot];
    world.player.y = world.enemies.y[slot];
    world.player.hp = 1000;
    for (let i = 0; i < FADE_TICKS - 3; i++) stepWorld(world, IDLE_INPUT);
    expect(world.enemies.phase[slot]).toBe(BLINK_PHASE.fading);
    expect(world.player.hp).toBe(1000);

    ticksUntil(world, slot, BLINK_PHASE.appear);
    world.player.x = world.enemies.x[slot];
    world.player.y = world.enemies.y[slot];
    stepWorld(world, IDLE_INPUT);
    expect(world.enemies.phase[slot]).toBe(BLINK_PHASE.appear);
    expect(world.player.hp).toBe(1000);
  });
});

describe("точка появления", () => {
  it("стоящий игрок: ровно blinkDistance от него, на любую сторону", () => {
    const sides = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const world = setup(seed);
      const slot = spawn(world);
      ticksUntil(world, slot, BLINK_PHASE.hidden);
      expect(distanceToPlayer(world, slot)).toBeCloseTo(DISTANCE * world.config.unitScale, 5);
      sides.add(`${Math.sign(world.enemies.x[slot])}${Math.sign(world.enemies.y[slot])}`);
    }
    // Направление не залипло на одной стороне.
    expect(sides.size).toBeGreaterThanOrEqual(3);
  });

  it("бегущий игрок: впереди по ходу, в пределах ±60°", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const world = setup(seed);
      const slot = spawn(world, 0, 400);
      ticksUntil(world, slot, BLINK_PHASE.hidden, RIGHT);
      const dx = world.enemies.x[slot] - world.player.x;
      const dy = world.enemies.y[slot] - world.player.y;
      const distance = Math.hypot(dx, dy);
      expect(distance).toBeCloseTo(DISTANCE * world.config.unitScale, 5);
      // Игрок бежит строго вправо: угол к оси x не больше 60°, то есть косинус не меньше 0,5.
      expect(dx / distance).toBeGreaterThanOrEqual(0.5 - 1e-6);
    }
  });

  it("не ближе 60 к игроку и не за границей карты, а упёршись в границу — прижимается", () => {
    // Полоса высотой 60 в обе стороны: у границы остаётся 60 − радиус врага.
    let pressed = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const world = setup(seed, { bounds: { halfWidth: Infinity, halfHeight: 60 } });
      const slot = spawn(world);
      ticksUntil(world, slot, BLINK_PHASE.hidden);
      const limit = 60 - world.enemyTypes[0].radius;
      const y = world.enemies.y[slot];
      expect(Math.abs(y)).toBeLessThanOrEqual(limit + 1e-6);
      expect(distanceToPlayer(world, slot)).toBeGreaterThanOrEqual(60 * world.config.unitScale - 1e-6);
      if (Math.abs(Math.abs(y) - limit) < 1e-6) pressed++;
    }
    expect(pressed).toBeGreaterThan(0);
  });

  it("то же зерно даёт ту же точку, другое — другую", () => {
    const point = (seed: number): [number, number] => {
      const world = setup(seed);
      const slot = spawn(world);
      ticksUntil(world, slot, BLINK_PHASE.hidden);
      return [world.enemies.x[slot], world.enemies.y[slot]];
    };
    expect(point(9)).toEqual(point(9));
    expect(point(9)).not.toEqual(point(10));
  });

  it("после появления враг стоит в точке метки, а не там, где таял", () => {
    const world = setup();
    const slot = spawn(world);
    ticksUntil(world, slot, BLINK_PHASE.fading);
    const meltedX = world.enemies.x[slot];
    ticksUntil(world, slot, BLINK_PHASE.hidden);
    const markX = world.enemies.x[slot];
    const markY = world.enemies.y[slot];
    expect(Math.abs(markX - meltedX)).toBeGreaterThan(50);

    ticksUntil(world, slot, BLINK_PHASE.appear);
    expect(world.enemies.x[slot]).toBe(markX);
    expect(world.enemies.y[slot]).toBe(markY);
    // Вернулся в поле зрения оружия.
    expect(findNearestEnemy(world, markX, markY, 20)).toBe(slot);
  });
});

describe("снимок и повтор", () => {
  it("снимок в hidden → восстановление → то же появление", () => {
    const original = setup(21, {}, [AURA]);
    const slot = spawn(original, 200, 0);
    ticksUntil(original, slot, BLINK_PHASE.hidden);
    for (let i = 0; i < 10; i++) stepWorld(original, IDLE_INPUT);

    const saved = JSON.parse(JSON.stringify(captureWorld(original, NO_SPAWNER))) as unknown;
    const resumed = setup(21, {}, [AURA]);
    restoreWorld(resumed, NO_SPAWNER, saved);
    expect(checksumWorld(resumed)).toBe(checksumWorld(original));

    // Скрытый остаётся скрытым и после восстановления: оружие по нему не бьёт.
    const hp = resumed.enemies.hp[slot];
    stepWorld(resumed, IDLE_INPUT);
    stepWorld(original, IDLE_INPUT);
    expect(resumed.enemies.hp[slot]).toBe(hp);
    expect(findNearestEnemy(resumed, resumed.enemies.x[slot], resumed.enemies.y[slot], 500)).toBe(-1);

    ticksUntil(original, slot, BLINK_PHASE.appear);
    ticksUntil(resumed, slot, BLINK_PHASE.appear);
    expect(resumed.enemies.x[slot]).toBe(original.enemies.x[slot]);
    expect(resumed.enemies.y[slot]).toBe(original.enemies.y[slot]);

    for (let i = 0; i < 600; i++) {
      stepWorld(original, RIGHT);
      stepWorld(resumed, RIGHT);
    }
    expect(checksumWorld(resumed)).toBe(checksumWorld(original));
  });

  it("повтор забега с тем же вводом даёт ту же сумму", () => {
    const run = (): number => {
      const world = setup(33);
      spawn(world, 250, 40);
      spawn(world, -300, -100);
      for (let i = 0; i < 1500; i++) stepWorld(world, i % 240 < 120 ? RIGHT : IDLE_INPUT);
      return checksumWorld(world);
    };
    expect(run()).toBe(run());
  });
});

describe("проверка параметров blink в контенте", () => {
  const kikimora = (params: Record<string, number>): EnemyDef =>
    ({ id: "kikimora", hp: 30, speed: 52, damage: 9, xp: 6, pattern: "blink", params }) as EnemyDef;

  it("называет врага и поле, вышедшее из коридора", () => {
    expect(findEnemyContentProblems([kikimora({ blinkDistance: 300 })])).toContain("враг kikimora: blinkDistance вне 60…200");
    expect(findEnemyContentProblems([kikimora({ blinkDistance: 59 })])).toContain("враг kikimora: blinkDistance вне 60…200");
    expect(findEnemyContentProblems([kikimora({ blinkEverySec: 1 })])).toContain("враг kikimora: blinkEverySec вне 1,5…10");
    expect(findEnemyContentProblems([kikimora({ blinkEverySec: 11 })])).toContain("враг kikimora: blinkEverySec вне 1,5…10");
    expect(findEnemyContentProblems([kikimora({ telegraphSec: 0.2 })])).toContain("враг kikimora: telegraphSec вне 0,3…1,5");
    expect(findEnemyContentProblems([kikimora({ telegraphSec: 2 })])).toContain("враг kikimora: telegraphSec вне 0,3…1,5");
  });

  it("границы коридоров и умолчания проходят", () => {
    expect(findEnemyContentProblems([kikimora({})])).toEqual([]);
    expect(findEnemyContentProblems([kikimora({ blinkDistance: 60, blinkEverySec: 1.5, telegraphSec: 0.3 })])).toEqual([]);
    expect(findEnemyContentProblems([kikimora({ blinkDistance: 200, blinkEverySec: 10, telegraphSec: 1.5 })])).toEqual([]);
  });

  it("параметр чужого паттерна блинку не принадлежит", () => {
    expect(findEnemyContentProblems([kikimora({ dashSpeed: 300 })])).toContain("враг kikimora: параметр dashSpeed не относится к паттерну blink");
  });
});
