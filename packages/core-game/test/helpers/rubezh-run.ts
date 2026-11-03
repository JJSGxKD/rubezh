import type { EnemyDef } from "@bh/shared-types";
import { CHESTS } from "../../src/content/chests";
import { DROPS } from "../../src/content/drops";
import { ENEMIES } from "../../src/content/enemies";
import { MAPS } from "../../src/content/maps";
import { RUBEZH } from "../../src/content/rubezh";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../../src/content/upgrades";
import { IDLE_INPUT, stepWorld } from "../../src/game/sim/step";
import { createWorld, DEFAULT_SIM_CONFIG, TICK_HZ, TICK_SEC, type CreateWorldOptions, type World } from "../../src/game/sim/world";

/**
 * Мир для проверок рубежа: боевой контент, бессмертный игрок, без прокачки
 * (убитый страж роняет много опыта, а выбор улучшения останавливает мир).
 * Времени забега мир не ждёт — `jumpToSec` переставляет часы, и директор
 * спавна не нужен: страж приходит от `stepRubezh`, а не от таймлайна.
 */
export function createRubezhWorld(seed = 1, patch: Partial<CreateWorldOptions> = {}): World {
  return createWorld({
    seed,
    enemies: ENEMIES,
    weapons: [],
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    chests: CHESTS,
    map: MAPS[0],
    rubezh: RUBEZH,
    config: { progressionEnabled: false, player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 } },
    ...patch,
  });
}

/** Переставить часы мира: следующий шаг начнётся ровно на этой секунде. */
export function jumpToSec(world: World, sec: number): void {
  world.stats.tick = Math.round(sec * TICK_HZ);
  world.stats.elapsedSec = world.stats.tick * TICK_SEC;
}

export function stepTicks(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world, IDLE_INPUT);
}

/** Индексы живых стражей рубежа. */
export function aliveRubezhGuards(world: World): number[] {
  const typeIndex = world.enemyTypes.findIndex((type) => type.id === RUBEZH.guard);
  const found: number[] = [];
  for (let i = 0; i < world.enemies.count; i++) {
    if (world.enemies.alive[i] === 1 && world.enemies.type[i] === typeIndex) found.push(i);
  }
  return found;
}

/** Индекс типа врага по id. */
export function typeIndexOf(world: World, id: string): number {
  const index = world.enemyTypes.findIndex((type) => type.id === id);
  if (index < 0) throw new Error(`В мире нет врага ${id}`);
  return index;
}

/** Страж из контента: для проверок значений. */
export function guardDef(): EnemyDef {
  const def = ENEMIES.find((enemy) => enemy.id === RUBEZH.guard);
  if (def === undefined) throw new Error("В контенте нет стража рубежа");
  return def;
}
