import type { LevelCurveDef, LoadoutLimits, UpgradeOption } from "@bh/shared-types";
import type { EnemyType } from "../patterns/enemy-types";
import type { PassiveType, PlayerStats, PlayerStatsBase } from "../progression/passives";
import type { LoadoutState } from "../progression/loadout";
import type { WeaponType } from "../weapons/weapon-types";
import type { Rng } from "./rng";
import { gridCellSize, SpatialGrid } from "./grid";
import type { SimEvents } from "./events";
import { NO_OWNER_TYPE, type EnemyPool, type GemPool, type ProjectilePool } from "./pools";

export type { EnemyType } from "../patterns/enemy-types";
export { NO_OWNER_TYPE, type EnemyPool, type GemPool, type ProjectilePool } from "./pools";
// Сборка мира живёт отдельно: здесь — состояние забега и операции над ним.
export { createWorld, DEFAULT_SIM_CONFIG, type CreateWorldOptions } from "./create-world";

/** Броня не делает неуязвимым: сквозь неё всегда проходит доля урона. */
const MIN_DAMAGE_RATIO = 0.1;

/** Шаг симуляции фиксирован: 60 Гц. Рендер к нему не привязан. */
export const TICK_HZ = 60;
export const TICK_SEC = 1 / TICK_HZ;

export interface PlayerConfig {
  radius: number;
  maxHp: number;
  speedPxSec: number;
  /**
   * Разгон и торможение. Мгновенная смена скорости выглядит дёрганой:
   * персонаж телепортируется между направлениями вместо того, чтобы
   * поворачивать. Значение подобрано так, чтобы полная скорость набиралась
   * примерно за 0.1 с — управление остаётся отзывчивым.
   */
  accelerationPxSec2: number;
  attackDamage: number;
  attackCooldownSec: number;
  /** дальность наведения оружия, которое само ищет цель */
  attackRangePx: number;
  projectileSpeedPxSec: number;
  projectileRadius: number;
  /** базовый радиус притяжения кристаллов опыта */
  pickupRadiusPx: number;
}

export interface SimConfig {
  width: number;
  height: number;
  /**
   * Сколько физических пикселей приходится на одну игровую единицу.
   *
   * Контент задаёт скорости и размеры в единицах, независимых от плотности
   * экрана, а мир пересчитывает их под конкретное устройство. Без этого есть
   * только два варианта, и оба плохие: рисовать в CSS-пикселях и получить
   * мыло на телефоне с DPR 3, либо рисовать в физических и получить втрое
   * более мелкую и медленную игру на том же телефоне.
   */
  unitScale: number;
  maxEnemies: number;
  maxProjectiles: number;
  /**
   * Потолок кристаллов опыта на поле. При его достижении кристаллы
   * сливаются, а не копятся: опыт не должен стать третьей осью нагрузки
   * после врагов и снарядов (docs/26-stage2-plan.md, WP2).
   */
  maxGems: number;
  /**
   * Опыт, уровни и выбор улучшений. Стенд испытаний выключает прокачку:
   * растущая сила игрока меняет нагрузку по ходу прогона, и два замера
   * перестают быть сравнимыми (docs/25-week1-fps-trials.md §1).
   */
  progressionEnabled: boolean;
  player: PlayerConfig;
}

export interface PlayerState {
  x: number;
  y: number;
  /** позиция на предыдущем тике — рендер интерполирует между ними */
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  /**
   * Куда персонаж смотрит — единичный вектор последнего движения. Оружию,
   * которое бьёт по направлению, нужна цель и на остановке.
   */
  faceX: number;
  faceY: number;
  hp: number;
  maxHp: number;
  attackCooldown: number;
  alive: boolean;
}

export interface RunStats {
  tick: number;
  elapsedSec: number;
  enemiesSpawned: number;
  enemiesKilled: number;
  /** убийства игроком по индексу типа врага */
  killsByType: Uint32Array;
  damageTaken: number;
  /** индекс типа врага, нанёсшего смертельный урон; -1 — игрок жив */
  deathCauseType: number;
  shotsFired: number;
  damageDealt: number;
  /**
   * Нанесённый урон по номеру оружия в наборе — главный вход геймдизайнера
   * для баланса оружий (docs/26-stage2-plan.md, WP3).
   */
  damageByWeapon: Float32Array;
  xpCollected: number;
}

/** Опыт, уровень и очередь выборов внутри забега. */
export interface ProgressionState {
  level: number;
  /** опыт на текущем уровне */
  xp: number;
  /** сколько опыта нужно до следующего уровня */
  xpToNext: number;
  totalXp: number;
  /** набранные, но ещё не отыгранные уровни */
  pendingLevelUps: number;
  /** предложенные варианты; непустой список означает, что мир ждёт выбора */
  offers: UpgradeOption[];
}

export interface World {
  config: SimConfig;
  rng: Rng;
  enemyTypes: EnemyType[];
  weaponTypes: WeaponType[];
  passiveTypes: PassiveType[];
  levelCurve: LevelCurveDef;
  loadoutLimits: LoadoutLimits;
  player: PlayerState;
  /** характеристики игрока с учётом пассивок — пересчитываются при улучшении */
  playerStats: PlayerStats;
  /** значения без улучшений: от них считается пересчёт */
  playerStatsBase: PlayerStatsBase;
  loadout: LoadoutState;
  progression: ProgressionState;
  enemies: EnemyPool;
  projectiles: ProjectilePool;
  gems: GemPool;
  /** с какого слота искать кристалл для слияния при переполнении пула */
  gemMergeCursor: number;
  enemyGrid: SpatialGrid;
  stats: RunStats;
  /** события для рендера — симуляция о рендере не знает */
  events: SimEvents;
  /** переиспользуемый буфер под результаты запросов к сетке */
  queryBuffer: Int32Array;
}

export function resizeWorld(world: World, width: number, height: number): void {
  if (width <= 0 || height <= 0) return;
  if (width === world.config.width && height === world.config.height) return;

  world.config.width = width;
  world.config.height = height;

  const radius = world.config.player.radius;
  world.player.x = clampTo(world.player.x, radius, width - radius);
  world.player.y = clampTo(world.player.y, radius, height - radius);
  world.player.prevX = world.player.x;
  world.player.prevY = world.player.y;

  // Сетка привязана к размерам поля — пересоздаём. Аллокация здесь допустима:
  // это происходит при изменении размера окна, а не в кадре.
  world.enemyGrid = new SpatialGrid(width, height, gridCellSize(world.config.unitScale), world.config.maxEnemies);
}

function clampTo(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Занять свободный слот врага. -1, если пул исчерпан. */
export function spawnEnemy(world: World, typeIndex: number, x: number, y: number): number {
  const pool = world.enemies;
  const slot = findFreeSlot(pool.alive, pool.count, world.config.maxEnemies);
  if (slot < 0) return -1;

  pool.x[slot] = x;
  pool.y[slot] = y;
  // Предыдущая позиция равна текущей: иначе только что заспавненный враг
  // на первом кадре «прилетает» из старой позиции переиспользованного слота.
  pool.prevX[slot] = x;
  pool.prevY[slot] = y;
  pool.vx[slot] = 0;
  pool.vy[slot] = 0;
  pool.hp[slot] = world.enemyTypes[typeIndex].hp;
  pool.attackCooldown[slot] = 0;
  pool.type[slot] = typeIndex;
  pool.alive[slot] = 1;
  // Состояние паттерна сбрасывается целиком: слот мог принадлежать врагу с
  // другим поведением, и его фаза рывка не должна достаться новому врагу.
  pool.phase[slot] = 0;
  pool.phaseTimer[slot] = 0;
  pool.dirX[slot] = 0;
  pool.dirY[slot] = 0;
  pool.ringRadius[slot] = 0;
  if (slot >= pool.count) pool.count = slot + 1;
  pool.aliveCount++;
  world.stats.enemiesSpawned++;
  return slot;
}

/**
 * Убрать врага из мира без засчитанного убийства и без реакции на смерть —
 * например, подрывник, взорвавшийся сам. Убийство игроком — `killEnemy` в
 * шаге симуляции: там счётчики и реакции паттерна на смерть.
 */
export function despawnEnemy(world: World, index: number): void {
  if (world.enemies.alive[index] === 0) return;
  world.enemies.alive[index] = 0;
  world.enemies.aliveCount--;
}

/**
 * Урон игроку с указанием источника. Источник нужен статистике: какой враг
 * убивает чаще всего — прямой вход геймдизайнера для баланса
 * (docs/26-stage2-plan.md, WP1, «Аналитика»).
 */
export function damagePlayer(world: World, amount: number, sourceType: number): void {
  const player = world.player;
  if (!player.alive || amount <= 0) return;

  // Броня вычитается, но не обнуляет урон: иначе несколько уровней брони
  // делают рой безобидным, и вся кривая сложности перестаёт работать.
  const reduced = Math.max(amount * MIN_DAMAGE_RATIO, amount - world.playerStats.armor);
  player.hp -= reduced;
  world.stats.damageTaken += reduced;
  if (player.hp <= 0) {
    player.hp = 0;
    player.alive = false;
    world.stats.deathCauseType = sourceType;
  }
}

export function spawnProjectile(
  world: World,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  ttlSec: number,
  fromPlayer: boolean,
): number {
  const pool = world.projectiles;
  const slot = findFreeSlot(pool.alive, pool.count, world.config.maxProjectiles);
  if (slot < 0) return -1;

  pool.x[slot] = x;
  pool.y[slot] = y;
  pool.prevX[slot] = x;
  pool.prevY[slot] = y;
  pool.vx[slot] = vx;
  pool.vy[slot] = vy;
  pool.damage[slot] = damage;
  pool.ttl[slot] = ttlSec;
  pool.fromPlayer[slot] = fromPlayer ? 1 : 0;
  // Владельца и пробивание выставляет стреляющий после спавна; без сброса
  // снаряд унаследовал бы их от прежнего снаряда в этом слоте.
  pool.ownerType[slot] = NO_OWNER_TYPE;
  pool.ownerWeapon[slot] = NO_OWNER_TYPE;
  pool.pierce[slot] = 0;
  pool.lastHit[slot] = -1;
  pool.alive[slot] = 1;
  if (slot >= pool.count) pool.count = slot + 1;
  pool.aliveCount++;
  return slot;
}

/**
 * Линейный поиск свободного слота вместо списка свободных.
 * Сознательный размен: список свободных даёт O(1), но порядок выдачи слотов
 * начинает зависеть от истории смертей, а от порядка обхода зависит результат
 * симуляции. Детерминизм здесь дороже микросекунд — сначала ищем в занятой
 * части, и только потом расширяем границу.
 */
function findFreeSlot(alive: Uint8Array, count: number, capacity: number): number {
  for (let i = 0; i < count; i++) {
    if (alive[i] === 0) return i;
  }
  return count < capacity ? count : -1;
}
