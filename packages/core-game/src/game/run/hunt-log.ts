import type { RunHuntEntry } from "@bh/shared-types";
import type { EnemyType, World } from "../sim/world";
import { TICK_HZ } from "../sim/world";

/**
 * Журнал охоты и оценка сборки для очков эффективности (Р152,
 * tasks/T-0292). Только считают: ни `world.rng`, ни порядок событий не
 * трогают, поэтому эталоны баланса не двигаются.
 *
 * Время появления лежит рядом с пулом врагов, а не в нём: пул целиком уходит в
 * снимок и менял бы его формат, а нужно оно лишь элитам и боссам.
 */

/** Столько элит за забег не бывает; дальше журнал не пишется. */
export const MAX_HUNT_ENTRIES = 64;

export interface HuntState {
  /** тик появления врага по номеру слота; осмыслен, пока слот занят */
  spawnTick: Int32Array;
  log: RunHuntEntry[];
}

export function createHuntState(capacity: number): HuntState {
  return { spawnTick: new Int32Array(capacity), log: [] };
}

/** Запомнить момент появления. Дёшево, поэтому — для всех врагов: ранг на спавне не проверяется. */
export function markSpawn(world: World, slot: number): void {
  world.hunt.spawnTick[slot] = world.stats.tick;
}

/** Записать убитую элиту или босса; вызывается до освобождения слота. */
export function recordHunt(world: World, slot: number, type: EnemyType): void {
  if (type.rank !== "elite" && type.rank !== "boss") return;
  const log = world.hunt.log;
  if (log.length >= MAX_HUNT_ENTRIES) return;
  log.push({ rank: type.rank, value: type.xp, aliveSec: (world.stats.tick - world.hunt.spawnTick[slot]) / TICK_HZ });
}

/** Оценка сборки: эволюции × 2 + оружие на максимуме + навыки на максимуме. */
export function buildScore(world: World): number {
  let evolutions = 0;
  let maxedWeapons = 0;
  let maxedPassives = 0;
  for (const slot of world.loadout.weapons) {
    const type = world.weaponTypes[slot.typeIndex];
    if (type === undefined) continue;
    if (type.evolvedFrom !== undefined) evolutions++;
    if (slot.level >= type.levels.length) maxedWeapons++;
  }
  for (const slot of world.loadout.passives) {
    const type = world.passiveTypes[slot.typeIndex];
    if (type !== undefined && slot.level >= type.levels.length) maxedPassives++;
  }
  return evolutions * 2 + maxedWeapons + maxedPassives;
}

/** В снимок: журнал и время появления живых элит и боссов (остальным оно не нужно). */
export interface HuntSnapshot {
  log: RunHuntEntry[];
  spawns: { slot: number; tick: number }[];
}

export function captureHunt(world: World): HuntSnapshot {
  const enemies = world.enemies;
  const spawns: HuntSnapshot["spawns"] = [];
  for (let slot = 0; slot < enemies.count; slot++) {
    if (enemies.alive[slot] === 0) continue;
    const rank = world.enemyTypes[enemies.type[slot]]?.rank;
    if (rank === "elite" || rank === "boss") spawns.push({ slot, tick: world.hunt.spawnTick[slot] });
  }
  return { log: world.hunt.log.map((entry) => ({ ...entry })), spawns };
}
