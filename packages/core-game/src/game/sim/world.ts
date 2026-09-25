import type { ContinueDef, DifficultyDef, DropsDef, LevelCurveDef, LoadoutLimits, UpgradeOption } from "@bh/shared-types";
import type { EnemyType } from "../patterns/enemy-types";
import type { PassiveType, PlayerStats, PlayerStatsBase } from "../progression/passives";
import type { LoadoutState } from "../progression/loadout";
import type { WeaponType } from "../weapons/weapon-types";
import type { Rng } from "./rng";
import { ELEMENT_PHYSICAL } from "./element-ids";
import { clearStatuses } from "./elements";
import type { SpatialGrid } from "./grid";
import type { SimEvents } from "./events";
import type { ViewConfig, WorldBounds } from "./map-types";
import { NEVER_HIT, NO_OWNER_TYPE, type EnemyPool, type GemPool, type PickupPool, type ProjectilePool } from "./pools";
import { pushSimEvent, SIM_EVENT } from "./events";
import { isElite } from "../patterns";
import { pickStage, type EnemyStage } from "./stages";

export type { EnemyType } from "../patterns/enemy-types";
export { findStageProblems, pickStage, resolveStages, stageOf, MAX_STAGES, type EnemyStage } from "./stages";
export { NEVER_HIT, NO_OWNER_TYPE, type EnemyPool, type GemPool, type PickupPool, type ProjectilePool } from "./pools";
export type { ViewConfig, WorldBounds } from "./map-types";
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
  /**
   * Границы карты. Infinity по оси означает «границы нет» — так проверка
   * остаётся одним сравнением, без ветвления на «а ограничена ли ось»
   * (docs/26-stage2-plan.md, WP4.2).
   */
  bounds: WorldBounds;
  /** радиусы спавна и удержания: размер экрана на них не влияет */
  view: ViewConfig;
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
  /**
   * Кристаллы и подборы с убитых. Отдельно от прокачки: стресс-тест в
   * оболочке меряет нагрузку сегодняшнего забега, а в нём кристаллы — сотни
   * объектов на экране, хотя выбирать улучшения на прогоне некому. Не задано
   * при создании мира — следует за `progressionEnabled`.
   */
  lootEnabled: boolean;
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
   * которое бьёт по направлению, нужна цель и на остановке; кольцу спавна —
   * чтобы понимать, где «впереди», когда игрок стоит.
   */
  faceX: number;
  faceY: number;
  hp: number;
  maxHp: number;
  attackCooldown: number;
  alive: boolean;
  /** сколько тиков игрока ещё нельзя ранить — после второго шанса */
  invulnerableTicks: number;
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
   *
   * Двойная точность, а не одинарная: сумма по оружиям обязана сходиться с
   * общим уроном, иначе в статистике заводится необъяснимая недостача — и
   * тест этой сходимости ловил бы округление, а не ошибку в коде.
   */
  damageByWeapon: Float64Array;
  xpCollected: number;
  /** подобранные аптечки */
  medkitsCollected: number;
  /** подобранные магниты */
  magnetsCollected: number;
  /** подобранный динамит */
  dynamiteCollected: number;
  /** пройденное расстояние: в бесконечном мире это показатель стиля игры */
  distance: number;
  /** пик числа живых врагов за забег — сколько игрок вытянул одновременно */
  peakEnemies: number;
  /** сколько отставших врагов унесено вперёд — сигнал о темпе бегства игрока */
  enemiesRecycled: number;
  /** сколько раз игрок продолжил после смерти */
  continuesUsed: number;
  /** тик каждого продолжения; первые `continuesUsed` значимы */
  continueTicks: Int32Array;
}

/**
 * Потолок продолжений за забег — ёмкость `continueTicks`. Сколько их на самом
 * деле, решает контент (`content/continue.ts`); больше этого числа тест
 * контента не пропустит.
 */
export const MAX_CONTINUES_PER_RUN = 5;

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

/**
 * Сложность текущего отрезка таймлайна. Директор спавна выставляет её на
 * границе отрезка, а мир применяет при спавне: после упора в потолок живых
 * сложность растёт здоровьем и уроном, а не числом врагов
 * (docs/26-stage2-plan.md, WP4.4).
 */
export interface DifficultyState {
  /** индекс отрезка таймлайна; в аналитике это «волна» (wave_reached) */
  segment: number;
  /** секунда, на которой отрезок начался */
  segmentStartedSec: number;
  hpMul: number;
  damageMul: number;
  maxAlive: number;
}

export interface World {
  config: SimConfig;
  /** карта забега: разрез аналитики и ключ к параметрам камеры */
  mapId: string;
  rng: Rng;
  enemyTypes: EnemyType[];
  /** ступени врагов: открываются по ходу забега, прежние остаются в потоке */
  stages: EnemyStage[];
  weaponTypes: WeaponType[];
  passiveTypes: PassiveType[];
  levelCurve: LevelCurveDef;
  loadoutLimits: LoadoutLimits;
  /** что падает с убитых врагов */
  drops: DropsDef;
  /** второй шанс: сколько раз и с чем игрок возвращается после смерти */
  continueRules: ContinueDef;
  /**
   * Уровень сложности забега. Директор спавна накладывает его множители на
   * каждый отрезок таймлайна; от забега к забегу он не меняется.
   */
  difficultyLevel: DifficultyDef;
  player: PlayerState;
  /** характеристики игрока с учётом пассивок — пересчитываются при улучшении */
  playerStats: PlayerStats;
  /** значения без улучшений: от них считается пересчёт */
  playerStatsBase: PlayerStatsBase;
  loadout: LoadoutState;
  progression: ProgressionState;
  difficulty: DifficultyState;
  enemies: EnemyPool;
  projectiles: ProjectilePool;
  gems: GemPool;
  /** с какого слота искать кристалл для слияния при переполнении пула */
  gemMergeCursor: number;
  /** аптечки, магниты и динамит на поле */
  pickups: PickupPool;
  enemyGrid: SpatialGrid;
  stats: RunStats;
  /** события для рендера — симуляция о рендере не знает */
  events: SimEvents;
  /** переиспользуемый буфер под результаты запросов к сетке */
  queryBuffer: Int32Array;
  /**
   * Второй буфер — для перескока молнии (`sim/elements.ts`): его ищут
   * посреди цикла оружия по `queryBuffer`, и общий буфер затёр бы цикл
   * вызывающего.
   */
  chainBuffer: Int32Array;
  /** читы режима разработчика; у обычного забега — нейтральные значения */
  cheats: WorldCheats;
}

/**
 * Читы режима разработчика (docs/26-stage2-plan.md, WP14). Живут в мире, а не
 * в сцене: урон и скорость считает симуляция, и проверка на границе тика —
 * единственный способ не разойтись с тем, что видит игрок.
 *
 * Забег с любым включённым читом помечается и в рейтинг по умолчанию не
 * идёт — это решает сцена, а здесь только правила мира.
 */
export interface WorldCheats {
  /** урон по игроку не отнимает здоровья; вспышка попадания остаётся */
  godMode: boolean;
  /** любой урон по врагу убивает его */
  oneHitKill: boolean;
  /** множитель урона оружия поверх пассивок */
  damageMul: number;
  /** множитель скорости бега поверх пассивок */
  moveSpeedMul: number;
  /** враги стоят и не атакуют: паттерны не исполняются */
  freezeEnemies: boolean;
}

export const NO_CHEATS: Readonly<WorldCheats> = {
  godMode: false,
  oneHitKill: false,
  damageMul: 1,
  moveSpeedMul: 1,
  freezeEnemies: false,
};

export function hasActiveCheats(cheats: WorldCheats): boolean {
  return (
    cheats.godMode ||
    cheats.oneHitKill ||
    cheats.damageMul !== 1 ||
    cheats.moveSpeedMul !== 1 ||
    cheats.freezeEnemies
  );
}

/** Ограничить значение границей карты; с бесконечной границей это тождество. */
export function clampToBounds(value: number, halfExtent: number): number {
  return value < -halfExtent ? -halfExtent : value > halfExtent ? halfExtent : value;
}

/**
 * Занять свободный слот врага. -1, если пул исчерпан.
 *
 * Здоровье и урон берут множители текущего отрезка и застывают в слоте: враг,
 * вышедший на пятой минуте, не должен крепчать вместе с таймлайном, пока
 * игрок его добивает.
 */
export function spawnEnemy(world: World, typeIndex: number, x: number, y: number): number {
  const pool = world.enemies;
  const slot = findFreeSlot(pool.alive, pool.count, world.config.maxEnemies);
  if (slot < 0) return -1;

  const type = world.enemyTypes[typeIndex];
  // Элита ступеней не получает: она сама и есть контрольная точка сложности,
  // и приходит событием таймлайна в назначенную минуту.
  const stageIndex = isElite(type) ? 0 : pickStage(world);
  const stage = world.stages[stageIndex] ?? world.stages[0];
  pool.x[slot] = x;
  pool.y[slot] = y;
  // Предыдущая позиция равна текущей: иначе только что заспавненный враг
  // на первом кадре «прилетает» из старой позиции переиспользованного слота.
  pool.prevX[slot] = x;
  pool.prevY[slot] = y;
  pool.vx[slot] = 0;
  pool.vy[slot] = 0;
  pool.hp[slot] = type.hp * world.difficulty.hpMul * stage.hpMul;
  pool.maxHp[slot] = pool.hp[slot];
  pool.damage[slot] = type.damage * world.difficulty.damageMul * stage.damageMul;
  pool.hitTick[slot] = NEVER_HIT;
  pool.attackCooldown[slot] = 0;
  pool.type[slot] = typeIndex;
  pool.stage[slot] = stageIndex;
  pool.alive[slot] = 1;
  // Состояние паттерна сбрасывается целиком: слот мог принадлежать врагу с
  // другим поведением, и его фаза рывка не должна достаться новому врагу.
  pool.phase[slot] = 0;
  pool.phaseTimer[slot] = 0;
  pool.dirX[slot] = 0;
  pool.dirY[slot] = 0;
  pool.ringRadius[slot] = 0;
  clearStatuses(world, slot, NO_OWNER_TYPE);
  if (slot >= pool.count) pool.count = slot + 1;
  pool.aliveCount++;
  world.stats.enemiesSpawned++;
  return slot;
}

/**
 * Убрать врага из мира без засчитанного убийства и без реакции на смерть —
 * например, подрывник, взорвавшийся сам. Убийство игроком — killEnemy в
 * шаге симуляции: там счётчики и реакции паттерна на смерть.
 */
export function despawnEnemy(world: World, index: number): void {
  if (world.enemies.alive[index] === 0) return;
  world.enemies.alive[index] = 0;
  world.enemies.aliveCount--;
}

/** Снять снаряд с поля: попал, истёк или улетел за пределы удержания. */
export function despawnProjectile(world: World, index: number): void {
  world.projectiles.alive[index] = 0;
  world.projectiles.aliveCount--;
}

/**
 * Урон игроку с указанием источника. Источник нужен статистике: какой враг
 * убивает чаще всего — прямой вход геймдизайнера для баланса
 * (docs/26-stage2-plan.md, WP1, «Аналитика»).
 */
export function damagePlayer(world: World, amount: number, sourceType: number): void {
  const player = world.player;
  if (!player.alive || amount <= 0 || player.invulnerableTicks > 0) return;

  // Броня вычитается, но не обнуляет урон: иначе несколько уровней брони
  // делают рой безобидным, и вся кривая сложности перестаёт работать.
  const reduced = Math.max(amount * MIN_DAMAGE_RATIO, amount - world.playerStats.armor);
  // Бессмертие не глушит само попадание: разработчику нужно видеть, кто и
  // когда бьёт, иначе режим проверки телеграфов бесполезен.
  if (!world.cheats.godMode) {
    player.hp -= reduced;
    world.stats.damageTaken += reduced;
  }
  // Рендер обязан показать момент попадания: полоска здоровья в углу — не
  // обратная связь, игрок смотрит на персонажа, а не на цифры.
  pushSimEvent(world.events, {
    kind: SIM_EVENT.playerHit,
    x: player.x,
    y: player.y,
    radius: reduced,
    tick: world.stats.tick,
  });
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
  pool.element[slot] = ELEMENT_PHYSICAL;
  pool.statusChance[slot] = 0;
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
