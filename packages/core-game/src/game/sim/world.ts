import type { EnemyDef, EnemyPattern } from "@bh/shared-types";
import { createRng, type Rng } from "./rng";
import { SpatialGrid } from "./grid";

/** Шаг симуляции фиксирован: 60 Гц. Рендер к нему не привязан. */
export const TICK_HZ = 60;
export const TICK_SEC = 1 / TICK_HZ;

/**
 * Радиус врага в контенте не задаётся: геймдизайнер оперирует hp/speed/damage,
 * а размер — свойство представления и хитбокса, привязанное к паттерну.
 * Держим здесь, а не в content/enemies.ts, чтобы не расширять таблицу полем,
 * которое геймдизайнеру нечем осмысленно заполнять.
 */
const RADIUS_BY_PATTERN: Record<EnemyPattern, number> = {
  swarm: 7,
  chase: 12,
  kite_and_shoot: 9,
};

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
  attackRangePx: number;
  projectileSpeedPxSec: number;
  projectileRadius: number;
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
  player: PlayerConfig;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  width: 960,
  height: 640,
  unitScale: 1,
  maxEnemies: 512,
  maxProjectiles: 512,
  player: {
    radius: 10,
    maxHp: 100,
    speedPxSec: 190,
    accelerationPxSec2: 1900,
    attackDamage: 6,
    attackCooldownSec: 0.28,
    attackRangePx: 320,
    projectileSpeedPxSec: 520,
    projectileRadius: 4,
  },
};

/** Тип врага, разложенный из контента в плоский вид для горячего цикла. */
export interface EnemyType {
  id: string;
  hp: number;
  speed: number;
  damage: number;
  pattern: EnemyPattern;
  radius: number;
}

export interface PlayerState {
  x: number;
  y: number;
  /** позиция на предыдущем тике — рендер интерполирует между ними */
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  attackCooldown: number;
  alive: boolean;
}

/**
 * Пулы хранятся как структура массивов (SoA), а не массив объектов: обход
 * идёт по непрерывной памяти, а «убийство» врага не создаёт мусора — слот
 * помечается свободным и переиспользуется.
 */
export interface EnemyPool {
  x: Float32Array;
  y: Float32Array;
  /** позиции на предыдущем тике — для интерполяции при отрисовке */
  prevX: Float32Array;
  prevY: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  hp: Float32Array;
  /** таймер до следующей атаки: и контактной, и выстрела для kite_and_shoot */
  attackCooldown: Float32Array;
  type: Uint8Array;
  alive: Uint8Array;
  /** верхняя граница занятых слотов — обходим только её, а не всю ёмкость */
  count: number;
  aliveCount: number;
}

export interface ProjectilePool {
  x: Float32Array;
  y: Float32Array;
  prevX: Float32Array;
  prevY: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  damage: Float32Array;
  ttl: Float32Array;
  /** 1 — снаряд игрока, 0 — снаряд врага */
  fromPlayer: Uint8Array;
  alive: Uint8Array;
  count: number;
  aliveCount: number;
}

export interface RunStats {
  tick: number;
  elapsedSec: number;
  enemiesSpawned: number;
  enemiesKilled: number;
  damageTaken: number;
  shotsFired: number;
}

export interface World {
  config: SimConfig;
  rng: Rng;
  enemyTypes: EnemyType[];
  player: PlayerState;
  enemies: EnemyPool;
  projectiles: ProjectilePool;
  enemyGrid: SpatialGrid;
  stats: RunStats;
  /** переиспользуемый буфер под результаты запросов к сетке */
  queryBuffer: Int32Array;
}

export interface CreateWorldOptions {
  seed: number;
  /** контент инжектируется, чтобы тесты гоняли симуляцию на фикстурах */
  enemies: readonly EnemyDef[];
  config?: Partial<SimConfig>;
}

export function createWorld(options: CreateWorldOptions): World {
  const config: SimConfig = { ...DEFAULT_SIM_CONFIG, ...options.config };
  const { maxEnemies, maxProjectiles } = config;

  const scale = config.unitScale;
  const enemyTypes = options.enemies.map<EnemyType>((def) => ({
    id: def.id,
    hp: def.hp,
    speed: def.speed * scale,
    damage: def.damage,
    pattern: def.pattern,
    radius: RADIUS_BY_PATTERN[def.pattern] * scale,
  }));

  // Игрок пересчитывается тем же множителем — иначе на устройстве с высокой
  // плотностью он окажется медленнее врагов просто из-за арифметики.
  config.player = scalePlayerConfig(config.player, scale);

  if (enemyTypes.length > 255) {
    // type хранится в Uint8Array — расширение потребует смены типа массива
    throw new Error("Слишком много типов врагов для Uint8Array-пула");
  }

  return {
    config,
    rng: createRng(options.seed),
    enemyTypes,
    player: {
      x: config.width / 2,
      y: config.height / 2,
      prevX: config.width / 2,
      prevY: config.height / 2,
      vx: 0,
      vy: 0,
      hp: config.player.maxHp,
      maxHp: config.player.maxHp,
      attackCooldown: 0,
      alive: true,
    },
    enemies: {
      x: new Float32Array(maxEnemies),
      y: new Float32Array(maxEnemies),
      prevX: new Float32Array(maxEnemies),
      prevY: new Float32Array(maxEnemies),
      vx: new Float32Array(maxEnemies),
      vy: new Float32Array(maxEnemies),
      hp: new Float32Array(maxEnemies),
      attackCooldown: new Float32Array(maxEnemies),
      type: new Uint8Array(maxEnemies),
      alive: new Uint8Array(maxEnemies),
      count: 0,
      aliveCount: 0,
    },
    projectiles: {
      x: new Float32Array(maxProjectiles),
      y: new Float32Array(maxProjectiles),
      prevX: new Float32Array(maxProjectiles),
      prevY: new Float32Array(maxProjectiles),
      vx: new Float32Array(maxProjectiles),
      vy: new Float32Array(maxProjectiles),
      damage: new Float32Array(maxProjectiles),
      ttl: new Float32Array(maxProjectiles),
      fromPlayer: new Uint8Array(maxProjectiles),
      alive: new Uint8Array(maxProjectiles),
      count: 0,
      aliveCount: 0,
    },
    // размер клетки — порядка диаметра крупного врага: мельче даёт много
    // пустых клеток на запрос, крупнее возвращает лишних кандидатов
    enemyGrid: new SpatialGrid(config.width, config.height, gridCellSize(config), maxEnemies),
    stats: {
      tick: 0,
      elapsedSec: 0,
      enemiesSpawned: 0,
      enemiesKilled: 0,
      damageTaken: 0,
      shotsFired: 0,
    },
    // Буфер под всю ёмкость пула, а не фиксированные 256: при плотной толпе
    // запрос к сетке возвращает больше кандидатов, чем помещается, и лишние
    // молча отбрасываются. В игре это промахи снарядов сквозь врагов, в
    // замере — заниженная стоимость коллизий, то есть враньё в отчёте.
    queryBuffer: new Int32Array(maxEnemies),
  };
}

/**
 * Пересобрать мир под новый размер окна. Вызывается при повороте экрана и
 * при изменении размера окна на десктопе: без этого игрок остаётся зажат в
 * границах старого размера, а враги спавнятся по старому радиусу.
 */
function scalePlayerConfig(player: PlayerConfig, scale: number): PlayerConfig {
  if (scale === 1) return player;
  return {
    ...player,
    radius: player.radius * scale,
    speedPxSec: player.speedPxSec * scale,
    accelerationPxSec2: player.accelerationPxSec2 * scale,
    attackRangePx: player.attackRangePx * scale,
    projectileSpeedPxSec: player.projectileSpeedPxSec * scale,
    projectileRadius: player.projectileRadius * scale,
  };
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
  world.enemyGrid = new SpatialGrid(width, height, gridCellSize(world.config), world.config.maxEnemies);
}

function gridCellSize(config: SimConfig): number {
  return 48 * config.unitScale;
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
  if (slot >= pool.count) pool.count = slot + 1;
  pool.aliveCount++;
  world.stats.enemiesSpawned++;
  return slot;
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
