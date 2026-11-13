import type { EnemyDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { STALKER } from "../src/content/stalker";
import { createBot } from "../src/game/balance/bot";
import type { Bot } from "../src/game/balance/bot";
import { STALKER_FLEE_UNITS, stalkerFleeDirection } from "../src/game/balance/stalker-flee";
import { createStrongBot, STAND_FROM_SEC } from "../src/game/balance/strong-bot";
import { despawnStalker, spawnStalker } from "../src/game/sim/stalker-body";
import { stepWorld } from "../src/game/sim/step";
import { createWorld, DEFAULT_SIM_CONFIG, TICK_HZ, type World } from "../src/game/sim/world";

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
