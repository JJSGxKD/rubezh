import type { EnemyTrail } from "../patterns/enemy-types";
import { damagePlayer, TICK_HZ, type World } from "./world";

/**
 * Лужи на земле: след врага с полем `trail` (`content/enemies.ts`, Р157).
 * Болотник оставляет за собой лужи яда, и стоять в них больно — поле больше не
 * одинаково безопасно везде, приходится двигаться и выбирать путь.
 *
 * Лужа ставится в точке врага каждые `everySec` его жизни, первая — через
 * `everySec` после появления; умер враг — его лужи доживают свой срок.
 * Радиус, срок и урон берутся из типа врага, поэтому лужа хранит только место,
 * тип и остаток жизни. Игрок в луже получает урон тиками по полсекунды через
 * `damagePlayer`: броня, сопротивление и щит работают как обычно, а стихия и шанс
 * состояния — от врага, оставившего лужу. Перекрытые лужи не складываются: за
 * тик бьёт одна, сильнейшая.
 *
 * Случайности здесь нет: место и время лужи берутся из движения врага, поэтому
 * мир с лужами детерминирован и восстанавливается из снимка забега.
 */

/** Сколько луж живёт на поле: переполнение вытесняет самую старую. */
export const PUDDLE_POOL_SIZE = 64;

/** Урон лужи идёт тиками по полсекунды. */
export const PUDDLE_TICK_SEC = 0.5;
// Считается при вызове: world.ts и этот модуль импортируют друг друга, и на момент загрузки TICK_HZ ещё не задан.
const puddleTickTicks = (): number => Math.round(PUDDLE_TICK_SEC * TICK_HZ);

export interface PuddlePool {
  /** центр лужи — двойной точности, как позиции пулов: мир бесконечен */
  x: Float64Array;
  y: Float64Array;
  /** индекс типа врага, оставившего лужу: от него радиус, урон, стихия */
  type: Uint8Array;
  /** сколько тиков лужа ещё живёт */
  ttl: Int32Array;
  /** порядковый номер постановки: по нему определяется самая старая */
  seq: Int32Array;
  alive: Uint8Array;
  /** номер следующей постановки */
  nextSeq: number;
  /** сколько подряд тиков игрок простоял в лужах; вышел — ноль */
  playerTicks: number;
}

export interface HazardState {
  puddles: PuddlePool;
  /**
   * Отсчёт до следующей лужи у каждого слота врага, в тиках. Живёт здесь, а не в
   * пуле врагов: след — свойство одного модуля. Спавн обнуляет слот.
   */
  trail: { ticks: Int32Array };
}

export function createHazardState(maxEnemies: number): HazardState {
  return {
    puddles: {
      x: new Float64Array(PUDDLE_POOL_SIZE),
      y: new Float64Array(PUDDLE_POOL_SIZE),
      type: new Uint8Array(PUDDLE_POOL_SIZE),
      ttl: new Int32Array(PUDDLE_POOL_SIZE),
      seq: new Int32Array(PUDDLE_POOL_SIZE),
      alive: new Uint8Array(PUDDLE_POOL_SIZE),
      nextSeq: 0,
      playerTicks: 0,
    },
    trail: { ticks: new Int32Array(maxEnemies) },
  };
}

/** Сколько луж сейчас на поле. */
export function puddleCount(world: World): number {
  const alive = world.hazards.puddles.alive;
  let count = 0;
  for (let i = 0; i < PUDDLE_POOL_SIZE; i++) count += alive[i];
  return count;
}

/**
 * Поставить лужу типа врага `typeIndex` в точке. Свободного места нет — лужа
 * занимает слот самой старой: линейный поиск по шестидесяти четырём слотам, а
 * не список, чтобы порядок слотов не зависел от истории (как у пулов, `world.ts`).
 */
export function spawnPuddle(world: World, typeIndex: number, x: number, y: number): void {
  const trail = world.enemyTypes[typeIndex].trail;
  if (trail === null) return;
  const pool = world.hazards.puddles;

  let slot = -1;
  let oldest = -1;
  for (let i = 0; i < PUDDLE_POOL_SIZE; i++) {
    if (pool.alive[i] === 0) {
      slot = i;
      break;
    }
    if (oldest < 0 || pool.seq[i] < pool.seq[oldest]) oldest = i;
  }
  if (slot < 0) slot = oldest;

  pool.x[slot] = x;
  pool.y[slot] = y;
  pool.type[slot] = typeIndex;
  pool.ttl[slot] = Math.max(1, Math.round(trail.lifeSec * TICK_HZ));
  pool.seq[slot] = pool.nextSeq++;
  pool.alive[slot] = 1;
}

/**
 * Отсчёт следа живого врага: вызывается из хода врага, когда он не стоит
 * замороженным, — стоящий на месте лужу не оставляет.
 */
export function tickTrail(world: World, slot: number, typeIndex: number, trail: EnemyTrail): void {
  const ticks = world.hazards.trail.ticks;
  ticks[slot]++;
  if (ticks[slot] < Math.max(1, Math.round(trail.everySec * TICK_HZ))) return;
  ticks[slot] = 0;
  spawnPuddle(world, typeIndex, world.enemies.x[slot], world.enemies.y[slot]);
}

/**
 * Шаг луж: урон по игроку в луже, затем старение. Урон идёт раньше старения,
 * поэтому лужа бьёт все свои `lifeSec`, а не на тик меньше.
 */
export function stepHazards(world: World): void {
  const pool = world.hazards.puddles;
  const player = world.player;
  const reachPad = world.config.player.radius;

  let strongest = -1;
  let strongestDps = 0;
  if (player.alive) {
    for (let i = 0; i < PUDDLE_POOL_SIZE; i++) {
      if (pool.alive[i] === 0) continue;
      const trail = world.enemyTypes[pool.type[i]].trail;
      if (trail === null) continue;
      const dx = player.x - pool.x[i];
      const dy = player.y - pool.y[i];
      const reach = trail.radius + reachPad;
      if (dx * dx + dy * dy >= reach * reach) continue;
      // Первая из равных: порядок слотов детерминирован.
      if (trail.damagePerSec > strongestDps) {
        strongest = i;
        strongestDps = trail.damagePerSec;
      }
    }
  }

  if (strongest < 0) {
    pool.playerTicks = 0;
  } else if (++pool.playerTicks >= puddleTickTicks()) {
    pool.playerTicks = 0;
    damagePlayer(world, strongestDps * PUDDLE_TICK_SEC, pool.type[strongest]);
  }

  for (let i = 0; i < PUDDLE_POOL_SIZE; i++) {
    if (pool.alive[i] === 0) continue;
    if (--pool.ttl[i] <= 0) pool.alive[i] = 0;
  }
}
