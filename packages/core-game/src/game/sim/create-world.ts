import type {
  EnemyDef,
  LevelCurveDef,
  LoadoutLimits,
  PassiveDef,
  WeaponDef,
} from "@bh/shared-types";
import { resolveEnemyTypes } from "../patterns/enemy-types";
import { computePlayerStats, resolvePassiveTypes, type PlayerStatsBase } from "../progression/passives";
import { addWeapon, createLoadout } from "../progression/loadout";
import { xpForLevel } from "../progression/levels";
import { resolveWeaponTypes, type WeaponType } from "../weapons/weapon-types";
import { createRng } from "./rng";
import { gridCellSize, SpatialGrid } from "./grid";
import { createSimEvents } from "./events";
import { createEnemyPool, createGemPool, createProjectilePool, NO_OWNER_TYPE } from "./pools";
import type { PlayerConfig, SimConfig, World } from "./world";

/**
 * Создание мира вынесено из `world.ts`: там состояние забега и операции над
 * ним, здесь — сборка мира из контента и конфигурации. Обратной зависимости
 * нет: отсюда из `world.ts` берутся только типы.
 */

/**
 * Кривая опыта и слоты по умолчанию — заглушка для тестов симуляции, которым
 * прокачка не нужна. Игра и стенд передают значения из контента.
 */
const FALLBACK_LEVEL_CURVE: LevelCurveDef = { baseXp: 6, growth: 1.22 };
const FALLBACK_LOADOUT_LIMITS: LoadoutLimits = { weapons: 4, passives: 4 };

export const DEFAULT_SIM_CONFIG: SimConfig = {
  width: 960,
  height: 640,
  unitScale: 1,
  maxEnemies: 512,
  maxProjectiles: 512,
  maxGems: 256,
  progressionEnabled: true,
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
    pickupRadiusPx: 90,
  },
};

export interface CreateWorldOptions {
  seed: number;
  /** контент инжектируется, чтобы тесты гоняли симуляцию на фикстурах */
  enemies: readonly EnemyDef[];
  /** без оружия персонаж не атакует вовсе — так гоняются тесты паттернов */
  weapons?: readonly WeaponDef[];
  passives?: readonly PassiveDef[];
  levelCurve?: LevelCurveDef;
  loadoutLimits?: LoadoutLimits;
  /** чем игрок начинает забег; по умолчанию — первое стартовое оружие */
  startingWeaponId?: string;
  config?: Partial<SimConfig>;
}

export function createWorld(options: CreateWorldOptions): World {
  const config: SimConfig = { ...DEFAULT_SIM_CONFIG, ...options.config };
  const { maxEnemies, maxProjectiles } = config;

  const scale = config.unitScale;
  const enemyTypes = resolveEnemyTypes(options.enemies, scale);
  const weaponTypes = resolveWeaponTypes(options.weapons ?? [], scale);
  const passiveTypes = resolvePassiveTypes(options.passives ?? []);

  // Игрок пересчитывается тем же множителем — иначе на устройстве с высокой
  // плотностью он окажется медленнее врагов просто из-за арифметики.
  config.player = scalePlayerConfig(config.player, scale);

  if (enemyTypes.length >= NO_OWNER_TYPE) {
    // Тип хранится в Uint8Array, а значение 255 занято под «снаряд игрока» —
    // расширение потребует смены типа массивов
    throw new Error("Слишком много типов врагов для Uint8Array-пула");
  }

  const levelCurve = options.levelCurve ?? FALLBACK_LEVEL_CURVE;
  const loadoutLimits = options.loadoutLimits ?? FALLBACK_LOADOUT_LIMITS;
  const playerStatsBase: PlayerStatsBase = {
    maxHp: config.player.maxHp,
    pickupRadius: config.player.pickupRadiusPx,
  };

  const loadout = createLoadout();
  const startingWeapon = findStartingWeapon(weaponTypes, options.startingWeaponId);
  if (startingWeapon >= 0) addWeapon(loadout, startingWeapon);

  return {
    config,
    rng: createRng(options.seed),
    enemyTypes,
    weaponTypes,
    passiveTypes,
    levelCurve,
    loadoutLimits,
    playerStats: computePlayerStats(playerStatsBase, passiveTypes, new Map()),
    playerStatsBase,
    loadout,
    progression: {
      level: 1,
      xp: 0,
      xpToNext: xpForLevel(levelCurve, 1),
      totalXp: 0,
      pendingLevelUps: 0,
      offers: [],
    },
    player: {
      x: config.width / 2,
      y: config.height / 2,
      prevX: config.width / 2,
      prevY: config.height / 2,
      vx: 0,
      vy: 0,
      faceX: 1,
      faceY: 0,
      hp: config.player.maxHp,
      maxHp: config.player.maxHp,
      attackCooldown: 0,
      alive: true,
    },
    enemies: createEnemyPool(maxEnemies),
    projectiles: createProjectilePool(maxProjectiles),
    gems: createGemPool(config.progressionEnabled ? config.maxGems : 1),
    gemMergeCursor: 0,
    // размер клетки — порядка диаметра крупного врага: мельче даёт много
    // пустых клеток на запрос, крупнее возвращает лишних кандидатов
    enemyGrid: new SpatialGrid(config.width, config.height, gridCellSize(scale), maxEnemies),
    stats: {
      tick: 0,
      elapsedSec: 0,
      enemiesSpawned: 0,
      enemiesKilled: 0,
      killsByType: new Uint32Array(enemyTypes.length),
      damageTaken: 0,
      deathCauseType: -1,
      shotsFired: 0,
      damageDealt: 0,
      damageByWeapon: new Float64Array(Math.max(1, loadoutLimits.weapons)),
      xpCollected: 0,
      distance: 0,
      peakEnemies: 0,
    },
    events: createSimEvents(),
    // Буфер под всю ёмкость пула, а не фиксированные 256: при плотной толпе
    // запрос к сетке возвращает больше кандидатов, чем помещается, и лишние
    // молча отбрасываются. В игре это промахи снарядов сквозь врагов, в
    // замере — заниженная стоимость коллизий, то есть враньё в отчёте.
    queryBuffer: new Int32Array(maxEnemies),
  };
}

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
    pickupRadiusPx: player.pickupRadiusPx * scale,
  };
}

/** Первое стартовое оружие или запрошенное по id; -1 — оружия нет вовсе. */
function findStartingWeapon(types: readonly WeaponType[], requestedId?: string): number {
  if (requestedId !== undefined) {
    const requested = types.findIndex((type) => type.id === requestedId);
    if (requested >= 0) return requested;
  }
  return types.findIndex((type) => type.starting);
}
