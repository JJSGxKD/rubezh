import type { DropsDef } from "@bh/shared-types";
import { createDirection, randomDirection } from "./directions";
import { pushSimEvent, SIM_EVENT } from "./events";
import { vectorLength } from "./vector";
import { clampToBounds, type World } from "./world";

/**
 * Аптечки — лечение, которое надо заслужить и подобрать.
 *
 * Падают с убитых врагов: с рядовых — редко, с элиты — по шансу из контента
 * (`content/drops.ts`). Подбираются касанием и только при неполном здоровье:
 * с полным аптечка остаётся лежать, и когда за ней вернуться — решение игрока,
 * а не случайность маршрута. Притяжения, как у кристаллов, у неё нет по той же
 * причине.
 */

/** Потолок пула: больше аптечек на поле контент поставить не может. */
export const MAX_MEDKITS = 8;

/** Полёт аптечки от места смерти — дольше кристалла: она тяжелее и заметнее. */
export const MEDKIT_LAND_TICKS = 24;

/** Радиус аптечки в игровых единицах: по нему считается касание. */
export const MEDKIT_RADIUS_UNITS = 9;

const SCATTER_MIN = 8;
const SCATTER_MAX = 20;

const scratch = createDirection();

export function findMedkitContentProblems(medkits: DropsDef["medkits"]): string[] {
  const problems: string[] = [];
  const at = "drops.medkits";
  for (const key of ["chance", "eliteChance"] as const) {
    const value = medkits[key];
    if (!(value >= 0 && value <= 1)) problems.push(`${at}.${key} — от 0 до 1, сейчас ${value}`);
  }
  if (!(medkits.healRatio > 0 && medkits.healRatio <= 1)) {
    problems.push(`${at}.healRatio — больше 0 и не больше 1, сейчас ${medkits.healRatio}`);
  }
  if (!Number.isInteger(medkits.maxOnField) || medkits.maxOnField < 0 || medkits.maxOnField > MAX_MEDKITS) {
    problems.push(`${at}.maxOnField — целое от 0 до ${MAX_MEDKITS}, сейчас ${medkits.maxOnField}`);
  }
  return problems;
}

/**
 * Бросок на аптечку при убийстве. Генератор не вызывается, если шанс нулевой:
 * тесты и контент без аптечек не сдвигают последовательность случайных чисел.
 */
export function rollMedkit(world: World, x: number, y: number, elite: boolean): void {
  const def = world.drops.medkits;
  const chance = elite ? def.eliteChance : def.chance;
  if (chance <= 0) return;
  if (world.rng.nextFloat() >= chance) return;
  if (world.medkits.aliveCount >= def.maxOnField) return;

  randomDirection(world.rng, scratch);
  const distance = world.rng.nextRange(SCATTER_MIN, SCATTER_MAX) * world.config.unitScale;
  const bounds = world.config.bounds;
  spawnMedkit(
    world,
    clampToBounds(x + scratch.x * distance, bounds.halfWidth),
    clampToBounds(y + scratch.y * distance, bounds.halfHeight),
    x,
    y,
  );
}

export function spawnMedkit(world: World, x: number, y: number, originX = x, originY = y): boolean {
  const pool = world.medkits;
  for (let slot = 0; slot < pool.alive.length; slot++) {
    if (pool.alive[slot] === 1) continue;
    pool.x[slot] = x;
    pool.y[slot] = y;
    pool.originX[slot] = originX;
    pool.originY[slot] = originY;
    pool.bornTick[slot] = world.stats.tick;
    pool.alive[slot] = 1;
    pool.count = Math.max(pool.count, slot + 1);
    pool.aliveCount++;
    return true;
  }
  return false;
}

export function isMedkitFlying(world: World, index: number): boolean {
  return world.stats.tick - world.medkits.bornTick[index] < MEDKIT_LAND_TICKS;
}

/**
 * Подбор касанием и исчезновение за радиусом удержания — как у кристаллов:
 * в бесконечном мире за оставленной позади аптечкой не вернуться.
 */
export function updateMedkits(world: World): void {
  const pool = world.medkits;
  const player = world.player;
  const touch = world.config.player.radius + MEDKIT_RADIUS_UNITS * world.config.unitScale;
  const retention = world.config.view.retentionRadius;

  for (let i = 0; i < pool.count; i++) {
    if (pool.alive[i] === 0) continue;

    const distance = vectorLength(player.x - pool.x[i], player.y - pool.y[i]);
    if (distance > retention) {
      remove(world, i);
      continue;
    }
    if (!player.alive || isMedkitFlying(world, i) || distance > touch) continue;
    if (player.hp >= world.playerStats.maxHp) continue;

    heal(world, i);
  }
}

function heal(world: World, index: number): void {
  const player = world.player;
  const before = player.hp;
  player.hp = Math.min(world.playerStats.maxHp, player.hp + world.playerStats.maxHp * world.drops.medkits.healRatio);
  world.stats.medkitsCollected++;
  remove(world, index);

  // Рендер показывает, что аптечка сработала: цифра здоровья в углу — не
  // обратная связь, игрок смотрит на персонажа.
  pushSimEvent(world.events, {
    kind: SIM_EVENT.heal,
    x: player.x,
    y: player.y,
    radius: player.hp - before,
    tick: world.stats.tick,
  });
}

function remove(world: World, index: number): void {
  world.medkits.alive[index] = 0;
  world.medkits.aliveCount--;
}
