import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { STALKER } from "../src/content/stalker";
import { createBot } from "../src/game/balance/bot";
import type { Bot } from "../src/game/balance/bot";
import { createMovementTally, MOVEMENT_FROM_SEC, recordMovement, STILL_SPEED_SHARE, stillShareOf } from "../src/game/balance/movement";
import { STALKER_FLEE_UNITS, stalkerFleeDirection } from "../src/game/balance/stalker-flee";
import { createStrongBot, STAND_FROM_SEC } from "../src/game/balance/strong-bot";
import { despawnStalker, spawnStalker } from "../src/game/sim/stalker-body";
import { stepWorld } from "../src/game/sim/step";
import { createWorld, DEFAULT_SIM_CONFIG, TICK_HZ, type World } from "../src/game/sim/world";
import { simulateBalanceRun } from "../src/game/balance/simulate";

// Боты калибровки уходят от неубиваемого преследователя (Р205, tasks/T-0422):
// уклоняющийся и сильный (обе стойки) бегут, пассивный не меняется.

const KARACHUN: EnemyDef = { id: "karachun", hp: 1, speed: 110, damage: 0, xp: 0, pattern: "stalker" };
const KARACHUN_TYPE = 0;
const RUN_TICKS = 600;

function makeWorld(startSec = 0): World {
  const world = createWorld({
    seed: 11,
    enemies: [KARACHUN],
    stalker: STALKER,
    config: {
      progressionEnabled: false,
      player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1000 },
    },
  });
  world.stats.tick = Math.round(startSec * TICK_HZ);
  return world;
}

/** Мир с Карачуном в 150 единицах от игрока. */
function withStalker(startSec = 0): World {
  const world = makeWorld(startSec);
  expect(spawnStalker(world, KARACHUN_TYPE, 150 * world.config.unitScale, 0)).toBeGreaterThanOrEqual(0);
  return world;
}

/** Ведёт бота `ticks` тиков и возвращает пройденное игроком расстояние от старта. */
function drive(world: World, bot: Bot, ticks: number): number {
  const startX = world.player.x;
  const startY = world.player.y;
  for (let i = 0; i < ticks; i++) stepWorld(world, bot.input(world));
  return Math.sqrt((world.player.x - startX) ** 2 + (world.player.y - startY) ** 2);
}

describe("уход ботов от преследователя", () => {
  it("уклоняющийся бот не получает касаний", () => {
    const world = withStalker();
    drive(world, createBot("dodging"), RUN_TICKS);
    expect(world.stats.damageTaken).toBe(0);
  });

  it("сильный «бегает» не получает касаний", () => {
    const world = withStalker();
    drive(world, createStrongBot({ stance: "kite" }), RUN_TICKS);
    expect(world.stats.damageTaken).toBe(0);
  });

  it("сильный «стоит» после STAND_FROM_SEC уходит и не получает касаний", () => {
    const world = withStalker(STAND_FROM_SEC + 20);
    const moved = drive(world, createStrongBot({ stance: "stand" }), RUN_TICKS);
    expect(world.stats.damageTaken).toBe(0);
    expect(moved / world.config.unitScale).toBeGreaterThan(150);
  });

  it("после ухода преследователя «стоит» снова стоит", () => {
    const world = withStalker(STAND_FROM_SEC + 20);
    const bot = createStrongBot({ stance: "stand" });
    drive(world, bot, RUN_TICKS);
    despawnStalker(world);
    // Пусть дошагает начатый шаг и выдержит паузу: дальше покой.
    drive(world, bot, 200);
    const moved = drive(world, bot, 300);
    expect(moved / world.config.unitScale).toBeLessThan(5);
  });

  it("пассивный бот касание получает", () => {
    const world = withStalker();
    drive(world, createBot("passive"), RUN_TICKS);
    expect(world.stats.damageTaken).toBeGreaterThan(0);
  });
});

describe("направление ухода", () => {
  it("без преследователя возвращает false", () => {
    expect(stalkerFleeDirection(makeWorld(), { x: 0, y: 0 })).toBe(false);
  });

  it("дальше радиуса возвращает false", () => {
    const world = makeWorld();
    spawnStalker(world, KARACHUN_TYPE, (STALKER_FLEE_UNITS + 50) * world.config.unitScale, 0);
    expect(stalkerFleeDirection(world, { x: 0, y: 0 })).toBe(false);
  });

  it("ближе радиуса пишет единичное направление от преследователя", () => {
    const world = withStalker();
    const out = { x: 0, y: 0 };
    expect(stalkerFleeDirection(world, out)).toBe(true);
    expect(out.x).toBeCloseTo(-1, 6);
    expect(out.y).toBeCloseTo(0, 6);
  });
});

// Мера движения (Р223, tasks/T-0472): доля тиков, когда скорость игрока ниже порога движения бота. Ею
// мерится стоящий бот с Карачуном и без него; сбор идёт по ходу прогона и на симуляцию не влияет.
describe("мера движения: доля времени на месте", () => {
  /** Ведёт мир `ticks` тиков с постоянным вводом и считает долю тиков на месте. */
  function stillShareOfInput(moveX: number, moveY: number, ticks: number): number {
    const world = makeWorld();
    const tally = createMovementTally();
    for (let i = 0; i < ticks; i++) {
      stepWorld(world, { moveX, moveY });
      recordMovement(tally, world);
    }
    return stillShareOf(tally);
  }

  it("бот стоит — доля 1", () => {
    expect(stillShareOfInput(0, 0, 300)).toBe(1);
  });

  it("бот бегает — доля около нуля: считаются только тики разгона", () => {
    expect(stillShareOfInput(1, 0, 300)).toBeLessThan(0.05);
  });

  it("пустая выборка — доля 0, а не NaN", () => {
    expect(stillShareOf(createMovementTally())).toBe(0);
  });

  it("порог — десятая доля бега: медленнее порога считается стоянкой, быстрее — движением", () => {
    const world = makeWorld();
    const tally = createMovementTally();
    const speed = world.config.player.speedPxSec;
    world.player.vx = speed * (STILL_SPEED_SHARE * 0.9);
    recordMovement(tally, world);
    world.player.vx = speed * (STILL_SPEED_SHARE * 1.1);
    recordMovement(tally, world);
    expect(tally).toEqual({ still: 1, total: 2 });
  });

  it("скорость считается по обеим осям: диагональ тоже движение", () => {
    const world = makeWorld();
    const tally = createMovementTally();
    const part = world.config.player.speedPxSec * STILL_SPEED_SHARE * 0.8;
    world.player.vx = part;
    world.player.vy = part;
    recordMovement(tally, world);
    expect(tally.still).toBe(0);
  });

  it("сбор не меняет симуляцию: забег с мерой и без неё побитово одинаков", () => {
    const first = makeWorld();
    const second = makeWorld();
    const tally = createMovementTally();
    for (let i = 0; i < 120; i++) {
      stepWorld(first, { moveX: 1, moveY: 0.5 });
      stepWorld(second, { moveX: 1, moveY: 0.5 });
      recordMovement(tally, first);
    }
    expect([first.player.x, first.player.y]).toEqual([second.player.x, second.player.y]);
  });
});

describe("мера движения в прогоне калибровки", () => {
  /** Доля на месте в окне меры; прогон короче окна пуст — это ошибка теста, а не мера. */
  function windowShare(run: { movement?: { still: number; total: number } }): number {
    expect(run.movement, "прогон несёт меру движения").toBeDefined();
    expect(run.movement?.total ?? 0, "прогон дошёл до окна меры").toBeGreaterThan(0);
    return stillShareOf(run.movement ?? { still: 0, total: 0 });
  }

  it("окно меры начинается там же, где Карачун получает право прийти", () => {
    expect(MOVEMENT_FROM_SEC).toBe(STALKER.appear.fromSec);
  });

  it("считаются только тики окна: прогон короче окна даёт пустую меру", { timeout: 60_000 }, () => {
    const run = simulateBalanceRun({ seed: 1, skill: "passive", godMode: true, maxSec: 30 });
    expect(run.movement).toEqual({ still: 0, total: 0 });
  });

  it("пассивный бот стоит весь забег — доля 1, тиков от окна до конца (граница включена)", { timeout: 60_000 }, () => {
    const run = simulateBalanceRun({ seed: 1, skill: "passive", godMode: true, maxSec: MOVEMENT_FROM_SEC + 20 });
    expect(windowShare(run)).toBe(1);
    expect(run.movement?.total).toBe(20 * TICK_HZ + 1);
  });

  it("сильный «бегает» в окне в основном движется", { timeout: 120_000 }, () => {
    const run = simulateBalanceRun({ seed: 1, skill: "strong", stance: "kite", godMode: true, maxSec: MOVEMENT_FROM_SEC + 60, startingWeaponId: "spark" });
    expect(windowShare(run)).toBeLessThan(0.5);
  });

  it("сильный «стоит» в окне стоит заметно дольше, чем «бегает»", { timeout: 120_000 }, () => {
    const options = { seed: 1, skill: "strong", godMode: true, maxSec: MOVEMENT_FROM_SEC + 90, startingWeaponId: "spark" } as const;
    const stand = windowShare(simulateBalanceRun({ ...options, stance: "stand" }));
    const kite = windowShare(simulateBalanceRun({ ...options, stance: "kite" }));
    expect(stand).toBeGreaterThan(kite + 0.2);
  });
});
