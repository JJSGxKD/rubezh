import type { DropsDef } from "@bh/shared-types";
// Импорт по кругу (combat.ts зовёт выпадение подборов, динамит зовёт
// убийство) безопасен: обе функции вызываются в игре, а не при загрузке модуля.
import { killEnemy } from "./combat";
import { createDirection, randomDirection } from "./directions";
import { pushSimEvent, SIM_EVENT } from "./events";
import { vectorLength } from "./vector";
import { clampToBounds, type World } from "./world";

/**
 * Подборы — предметы, которые падают с убитых врагов и срабатывают от касания:
 * аптечка, магнит опыта и динамит. Шансы и числа — в контенте
 * (`content/drops.ts`).
 *
 * - **Аптечка** лечит долю здоровья и подбирается только при неполном
 *   здоровье: с полным она остаётся лежать, и когда за ней вернуться, решает
 *   игрок.
 * - **Магнит** притягивает к игроку все кристаллы на поле — награда за то, что
 *   их накопилось много.
 * - **Динамит** взрывается вокруг игрока: рядовых врагов в радиусе выкашивает,
 *   элите снимает долю здоровья, но не убивает — контрольная точка сложности
 *   не должна пропускаться одним подбором.
 *
 * Притяжения, как у кристаллов, у подборов нет: к ним идут сами.
 */

export const PICKUP_KIND = {
  medkit: 0,
  magnet: 1,
  dynamite: 2,
} as const;

export type PickupKind = (typeof PICKUP_KIND)[keyof typeof PICKUP_KIND];

/** Потолок пула: всех подборов на поле не больше. */
export const MAX_PICKUPS = 16;

/** Потолок одного вида на поле, который может задать контент. */
export const MAX_PICKUPS_OF_KIND = 8;

/** Полёт подбора от места смерти — дольше кристалла: он тяжелее и заметнее. */
export const PICKUP_LAND_TICKS = 24;

/** Радиус подбора в игровых единицах: по нему считается касание. */
export const PICKUP_RADIUS_UNITS = 9;

const SCATTER_MIN = 8;
const SCATTER_MAX = 20;

const scratch = createDirection();

// --- Контент ------------------------------------------------------------------

export function findPickupContentProblems(drops: DropsDef): string[] {
  const problems: string[] = [];
  const chances = [
    ["medkits", drops.medkits],
    ["magnets", drops.magnets],
    ["dynamite", drops.dynamite],
  ] as const;

  for (const [name, def] of chances) {
    const at = `drops.${name}`;
    for (const key of ["chance", "eliteChance"] as const) {
      const value = def[key];
      if (!(value >= 0 && value <= 1)) problems.push(`${at}.${key} — от 0 до 1, сейчас ${value}`);
    }
    if (!Number.isInteger(def.maxOnField) || def.maxOnField < 0 || def.maxOnField > MAX_PICKUPS_OF_KIND) {
      problems.push(`${at}.maxOnField — целое от 0 до ${MAX_PICKUPS_OF_KIND}, сейчас ${def.maxOnField}`);
    }
  }

  if (!(drops.medkits.healRatio > 0 && drops.medkits.healRatio <= 1)) {
    problems.push(`drops.medkits.healRatio — больше 0 и не больше 1, сейчас ${drops.medkits.healRatio}`);
  }
  if (!(drops.dynamite.radiusUnits > 0)) {
    problems.push(`drops.dynamite.radiusUnits — больше 0, сейчас ${drops.dynamite.radiusUnits}`);
  }
  if (!(drops.dynamite.eliteHpRatio >= 0 && drops.dynamite.eliteHpRatio < 1)) {
    // Единица и больше убивала бы элиту — ровно то, чего динамит делать не должен.
    problems.push(`drops.dynamite.eliteHpRatio — от 0 до 1, не включая 1, сейчас ${drops.dynamite.eliteHpRatio}`);
  }
  return problems;
}

// --- Выпадение ----------------------------------------------------------------

/**
 * Броски на все подборы при убийстве, в фиксированном порядке. Генератор не
 * вызывается там, где шанс нулевой: тесты и контент без подбора не сдвигают
 * последовательность случайных чисел.
 */
export function rollPickups(world: World, x: number, y: number, elite: boolean): void {
  const drops = world.drops;
  roll(world, PICKUP_KIND.medkit, drops.medkits, x, y, elite);
  roll(world, PICKUP_KIND.magnet, drops.magnets, x, y, elite);
  roll(world, PICKUP_KIND.dynamite, drops.dynamite, x, y, elite);
}

function roll(
  world: World,
  kind: PickupKind,
  def: { chance: number; eliteChance: number; maxOnField: number },
  x: number,
  y: number,
  elite: boolean,
): void {
  const chance = elite ? def.eliteChance : def.chance;
  if (chance <= 0) return;
  if (world.rng.nextFloat() >= chance) return;
  if (countOnField(world, kind) >= def.maxOnField) return;

  randomDirection(world.rng, scratch);
  const distance = world.rng.nextRange(SCATTER_MIN, SCATTER_MAX) * world.config.unitScale;
  const bounds = world.config.bounds;
  spawnPickup(
    world,
    kind,
    clampToBounds(x + scratch.x * distance, bounds.halfWidth),
    clampToBounds(y + scratch.y * distance, bounds.halfHeight),
    x,
    y,
  );
}

export function spawnPickup(
  world: World,
  kind: PickupKind,
  x: number,
  y: number,
  originX = x,
  originY = y,
): boolean {
  const pool = world.pickups;
  for (let slot = 0; slot < pool.alive.length; slot++) {
    if (pool.alive[slot] === 1) continue;
    pool.x[slot] = x;
    pool.y[slot] = y;
    pool.originX[slot] = originX;
    pool.originY[slot] = originY;
    pool.bornTick[slot] = world.stats.tick;
    pool.kind[slot] = kind;
    pool.alive[slot] = 1;
    pool.count = Math.max(pool.count, slot + 1);
    pool.aliveCount++;
    return true;
  }
  return false;
}

export function countOnField(world: World, kind: PickupKind): number {
  const pool = world.pickups;
  let count = 0;
  for (let i = 0; i < pool.count; i++) {
    if (pool.alive[i] === 1 && pool.kind[i] === kind) count++;
  }
  return count;
}

export function isPickupFlying(world: World, index: number): boolean {
  return world.stats.tick - world.pickups.bornTick[index] < PICKUP_LAND_TICKS;
}

// --- Подбор -------------------------------------------------------------------

/**
 * Подбор касанием и исчезновение за радиусом удержания — как у кристаллов:
 * в бесконечном мире за оставленным позади подбором не вернуться.
 */
export function updatePickups(world: World): void {
  const pool = world.pickups;
  const player = world.player;
  const touch = world.config.player.radius + PICKUP_RADIUS_UNITS * world.config.unitScale;
  const retention = world.config.view.retentionRadius;

  for (let i = 0; i < pool.count; i++) {
    if (pool.alive[i] === 0) continue;

    const distance = vectorLength(player.x - pool.x[i], player.y - pool.y[i]);
    if (distance > retention) {
      remove(world, i);
      continue;
    }
    if (!player.alive || isPickupFlying(world, i) || distance > touch) continue;

    switch (pool.kind[i]) {
      case PICKUP_KIND.medkit:
        if (player.hp >= world.playerStats.maxHp) continue;
        remove(world, i);
        heal(world);
        break;
      case PICKUP_KIND.magnet:
        remove(world, i);
        attractAllGems(world);
        break;
      default:
        remove(world, i);
        detonate(world);
    }
  }
}

function heal(world: World): void {
  const player = world.player;
  const before = player.hp;
  player.hp = Math.min(world.playerStats.maxHp, player.hp + world.playerStats.maxHp * world.drops.medkits.healRatio);
  world.stats.medkitsCollected++;

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

/**
 * Магнит: все кристаллы на поле тянутся к игроку. Летящие тоже — они начнут
 * тянуться, как только приземлятся.
 */
function attractAllGems(world: World): void {
  const gems = world.gems;
  for (let i = 0; i < gems.count; i++) {
    if (gems.alive[i] === 1) gems.attracted[i] = 1;
  }
  world.stats.magnetsCollected++;
  pushSimEvent(world.events, {
    kind: SIM_EVENT.magnet,
    x: world.player.x,
    y: world.player.y,
    radius: world.config.view.spawnRadius,
    tick: world.stats.tick,
  });
}

/**
 * Динамит: взрыв вокруг игрока. Рядовые враги в радиусе погибают с убийством
 * и выпадением — игрок получает и передышку, и россыпь кристаллов. Элита
 * теряет долю здоровья, но не ниже единицы.
 *
 * Урон динамита не пишется в урон по оружиям: таблица урона — вход для
 * баланса оружий, и подбор исказил бы её.
 */
function detonate(world: World): void {
  const enemies = world.enemies;
  const player = world.player;
  const radius = world.drops.dynamite.radiusUnits * world.config.unitScale;
  const radiusSq = radius * radius;
  world.stats.dynamiteCollected++;

  // Сначала список задетых, потом убийства: делящийся враг, погибая, ставит
  // потомков в пул, и обход по живому пулу задевал бы их через раз — в
  // зависимости от того, в какой слот они попали. Потомки переживают взрыв.
  const victims = world.queryBuffer;
  let found = 0;
  for (let i = 0; i < enemies.count && found < victims.length; i++) {
    if (enemies.alive[i] === 0) continue;
    const dx = enemies.x[i] - player.x;
    const dy = enemies.y[i] - player.y;
    if (dx * dx + dy * dy <= radiusSq) victims[found++] = i;
  }

  for (let k = 0; k < found; k++) {
    const i = victims[k];
    const type = world.enemyTypes[enemies.type[i]];
    enemies.hitTick[i] = world.stats.tick;
    if (!type.elite) {
      // Убийство взрывом — те же последствия, что у убийства оружием:
      // счётчики, кристаллы, подборы, реакция паттерна.
      killEnemy(world, i);
      continue;
    }
    const blast = type.hp * world.difficulty.hpMul * world.drops.dynamite.eliteHpRatio;
    enemies.hp[i] = Math.max(1, enemies.hp[i] - blast);
  }

  pushSimEvent(world.events, {
    kind: SIM_EVENT.dynamite,
    x: player.x,
    y: player.y,
    radius,
    tick: world.stats.tick,
  });
}


function remove(world: World, index: number): void {
  world.pickups.alive[index] = 0;
  world.pickups.aliveCount--;
}
