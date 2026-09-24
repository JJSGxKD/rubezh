import type {
  ContinueDef,
  DifficultyDef,
  DropsDef,
  EnemyDef,
  EnemyStageDef,
  LevelCurveDef,
  LoadoutLimits,
  MapDef,
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
import { resolveMap } from "./map-types";
import { createSimEvents } from "./events";
import { BASE_DIFFICULTY, findDifficultyProblems } from "./difficulty";
import { findStageProblems, resolveStages } from "./stages";
import { findContinueProblems } from "./continue";
import { findDropsContentProblems } from "./gems";
import { MAX_PICKUPS } from "./pickups";
import { createEnemyPool, createGemPool, createPickupPool, createProjectilePool, NO_OWNER_TYPE } from "./pools";
import { MAX_CONTINUES_PER_RUN, NO_CHEATS, type PlayerConfig, type SimConfig, type World } from "./world";

/**
 * Создание мира вынесено из world.ts: там состояние забега и операции над
 * ним, здесь — сборка мира из контента и конфигурации. Обратной зависимости
 * нет: отсюда из world.ts берутся только типы.
 */

/**
 * Кривая опыта и слоты по умолчанию — заглушка для тестов симуляции, которым
 * прокачка не нужна. Игра и стенд передают значения из контента.
 */
const FALLBACK_LEVEL_CURVE: LevelCurveDef = { baseXp: 6, growth: 1.22 };
const FALLBACK_LOADOUT_LIMITS: LoadoutLimits = {
  weapons: 4,
  passives: { attack: 4, defense: 4, mobility: 4 },
};

/**
 * Выпадение для тестов симуляции: один кристалл на врага и никаких подборов.
 * Горсть и броски на подборы расходуют генератор, и тест паттерна врага
 * сдвигал бы свою последовательность случайных чисел от правки выпадения, к
 * которому отношения не имеет.
 */
const FALLBACK_DROPS: DropsDef = {
  gems: { maxPerKill: 1 },
  medkits: { chance: 0, eliteChance: 0, healRatio: 0.3, maxOnField: 0 },
  magnets: { chance: 0, eliteChance: 0, maxOnField: 0 },
  dynamite: { chance: 0, eliteChance: 0, maxOnField: 0, radiusUnits: 420, eliteHpRatio: 0.3 },
};

/**
 * Второй шанс для тестов симуляции: одно продолжение с полным здоровьем. Мир
 * без смерти его не замечает, а тест продолжения задаёт свои числа.
 */
const FALLBACK_CONTINUE: ContinueDef = { perRun: 1, restoreHpRatio: 1, invulnerableSec: 3 };

/**
 * Карта по умолчанию — тоже заглушка, и тоже не из контента: симуляция не
 * импортирует content/*, иначе тест перестаёт быть тестом симуляции и
 * становится тестом текущего баланса. Числа совпадают с боевой картой, чтобы
 * прогоны тестов шли в том же масштабе мира, что и игра.
 */
const FALLBACK_MAP: MapDef = {
  id: "fallback",
  nameKey: "map.fallback.name",
  camera: {
    viewAreaMoving: 260_000,
    viewAreaIdle: 175_000,
    maxAspect: 2.2,
    followSmoothingSec: 0.12,
    zoomSmoothingSec: 0.5,
    zoomInDelaySec: 0.7,
  },
};

const FALLBACK_VIEW = resolveMap(FALLBACK_MAP, 1);

/**
 * Запас сетки коллизий за радиусом удержания: одна клетка с каждой стороны,
 * чтобы объект ровно на границе попадал в свою клетку, а не в краевую.
 */
const GRID_MARGIN_CELLS = 2;

export const DEFAULT_SIM_CONFIG: SimConfig = {
  unitScale: 1,
  bounds: FALLBACK_VIEW.bounds,
  view: FALLBACK_VIEW.view,
  maxEnemies: 512,
  maxProjectiles: 512,
  maxGems: 256,
  progressionEnabled: true,
  lootEnabled: true,
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
  /** что падает с убитых врагов; по умолчанию — один кристалл */
  drops?: DropsDef;
  /** второй шанс; по умолчанию — одно продолжение */
  continueRules?: ContinueDef;
  /** уровень сложности; по умолчанию — без поправок */
  difficulty?: DifficultyDef;
  /** ступени врагов; по умолчанию — одна базовая, без усиления */
  stages?: readonly EnemyStageDef[];
  /** карта: границы мира и параметры, от которых считается кольцо спавна */
  map?: MapDef;
  /** чем игрок начинает забег; по умолчанию — первое стартовое оружие */
  startingWeaponId?: string;
  config?: Partial<SimConfig>;
}

export function createWorld(options: CreateWorldOptions): World {
  const config: SimConfig = {
    ...DEFAULT_SIM_CONFIG,
    ...options.config,
    lootEnabled: options.config?.lootEnabled ?? options.config?.progressionEnabled ?? DEFAULT_SIM_CONFIG.lootEnabled,
  };
  const { maxEnemies, maxProjectiles } = config;

  const scale = config.unitScale;
  // Границы и радиусы — производные карты, а не свободные поля конфигурации:
  // иначе спавн на одном устройстве уедет относительно другого.
  const map = resolveMap(options.map ?? FALLBACK_MAP, scale);
  config.bounds = map.bounds;
  config.view = map.view;

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

  const drops = options.drops ?? FALLBACK_DROPS;
  const dropProblems = findDropsContentProblems(drops);
  if (dropProblems.length > 0) {
    throw new Error(`Некорректный контент выпадения:\n${dropProblems.join("\n")}`);
  }

  const continueRules = options.continueRules ?? FALLBACK_CONTINUE;
  const continueProblems = findContinueProblems(continueRules);
  if (continueProblems.length > 0) {
    throw new Error(`Некорректный второй шанс:\n${continueProblems.join("\n")}`);
  }

  const difficultyLevel = options.difficulty ?? BASE_DIFFICULTY;
  const difficultyProblems = findDifficultyProblems(difficultyLevel);
  if (difficultyProblems.length > 0) {
    throw new Error(`Некорректный уровень сложности:\n${difficultyProblems.join("\n")}`);
  }

  const stageProblems = findStageProblems(options.stages ?? []);
  if (stageProblems.length > 0) {
    throw new Error(`Некорректные ступени врагов:\n${stageProblems.join("\n")}`);
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

  const cellSize = gridCellSize(scale);
  return {
    config,
    mapId: map.id,
    rng: createRng(options.seed),
    enemyTypes,
    stages: resolveStages(options.stages),
    weaponTypes,
    passiveTypes,
    levelCurve,
    loadoutLimits,
    drops,
    continueRules,
    difficultyLevel,
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
    // До первого отрезка таймлайна сложность нейтральна: в мире без директора
    // спавна — стенд испытаний, тесты паттернов — она такой и остаётся.
    difficulty: {
      segment: 0,
      segmentStartedSec: 0,
      hpMul: 1,
      damageMul: 1,
      maxAlive: maxEnemies,
    },
    // Игрок стартует в начале координат: центр карты, если у неё есть
    // границы, и просто точка отсчёта, если мир бесконечен.
    player: {
      x: 0,
      y: 0,
      prevX: 0,
      prevY: 0,
      vx: 0,
      vy: 0,
      faceX: 1,
      faceY: 0,
      hp: config.player.maxHp,
      maxHp: config.player.maxHp,
      attackCooldown: 0,
      alive: true,
      invulnerableTicks: 0,
    },
    enemies: createEnemyPool(maxEnemies),
    projectiles: createProjectilePool(maxProjectiles),
    gems: createGemPool(config.lootEnabled ? config.maxGems : 1),
    gemMergeCursor: 0,
    pickups: createPickupPool(config.lootEnabled ? MAX_PICKUPS : 1),
    // Окно сетки накрывает радиус удержания целиком: всё, что дальше, живёт
    // считанные тики и попадает в краевые клетки без вреда для запросов.
    enemyGrid: new SpatialGrid(
      config.view.retentionRadius * 2 + cellSize * GRID_MARGIN_CELLS,
      cellSize,
      maxEnemies,
    ),
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
      medkitsCollected: 0,
      magnetsCollected: 0,
      dynamiteCollected: 0,
      distance: 0,
      peakEnemies: 0,
      enemiesRecycled: 0,
      continuesUsed: 0,
      continueTicks: new Int32Array(MAX_CONTINUES_PER_RUN),
    },
    events: createSimEvents(),
    // Буфер под всю ёмкость пула, а не фиксированные 256: при плотной толпе
    // запрос к сетке возвращает больше кандидатов, чем помещается, и лишние
    // молча отбрасываются. В игре это промахи снарядов сквозь врагов, в
    // замере — заниженная стоимость коллизий, то есть враньё в отчёте.
    queryBuffer: new Int32Array(maxEnemies),
    cheats: { ...NO_CHEATS },
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
