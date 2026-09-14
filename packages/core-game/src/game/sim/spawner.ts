import type { EnemyPattern } from "@bh/shared-types";
import { createDirection, directionInArc, randomDirection, type Direction } from "./directions";
import { vectorLength } from "./vector";
import { clampToBounds, spawnEnemy, type World } from "./world";

/**
 * Спавнер отделён от step(): у игрового забега и у стресс-прогона разные
 * правила появления врагов, а сама симуляция одна и та же. Для FPS-испытания
 * нужна стабильная популяция на экране, для игры — таймлайн из контента
 * (sim/director.ts).
 */
export interface Spawner {
  update(world: World, dtSec: number): void;
  /**
   * Состояние для снимка забега (game/run/snapshot.ts). Спавнеру, у которого
   * нет своего состояния между тиками, методы не нужны.
   */
  saveState?(): unknown;
  loadState?(state: unknown): void;
}

/** Разброс радиуса спавна, чтобы кольцо не читалось как ровная окружность. */
const SPAWN_JITTER_UNITS = 48;

/**
 * Раствор дуги, в которую уносит отставших врагов: синус половины угла.
 * 0.85 — это примерно ±58° от направления движения. Уже — и враги приходят
 * ровно в лоб, шире — и часть снова оказывается за спиной.
 */
const FORWARD_ARC_SIN = 0.85;

/**
 * Отступ от границы карты: враг не должен появляться вплотную к стене, иначе
 * он первым же шагом упирается в неё и стоит.
 */
const BOUNDS_MARGIN_UNITS = 8;

const direction = createDirection();
const point = { x: 0, y: 0 };

/**
 * Поставить врага на кольцо спавна в заданном направлении.
 *
 * Радиус кольца считается от максимальной видимой области и не зависит от
 * устройства (docs/26-stage2-plan.md, WP4.3): ни зум, ни поворот экрана, ни
 * широкий монитор не показывают момент появления врага.
 */
export function spawnOnRing(world: World, typeIndex: number, dirX: number, dirY: number): number {
  const radius =
    world.config.view.spawnRadius +
    world.rng.nextRange(0, SPAWN_JITTER_UNITS * world.config.unitScale);

  resolveRingPoint(world, dirX, dirY, radius, point);
  return spawnEnemy(world, typeIndex, point.x, point.y);
}

/** Спавн в случайном направлении — обычный поток врагов. */
export function spawnRandomOnRing(world: World, typeIndex: number): number {
  randomDirection(world.rng, direction);
  return spawnOnRing(world, typeIndex, direction.x, direction.y);
}

/**
 * Направление «вперёд» — туда, куда игрок идёт. На остановке берётся взгляд:
 * он хранит последнее направление движения и всегда единичный.
 */
export function forwardDirection(world: World, out: Direction): void {
  const player = world.player;
  const speed = vectorLength(player.vx, player.vy);
  if (speed < 1e-3) {
    out.x = player.faceX;
    out.y = player.faceY;
    return;
  }
  out.x = player.vx / speed;
  out.y = player.vy / speed;
}

/**
 * Точка на кольце с учётом границ карты.
 *
 * Из кольца выбираются только допустимые дуги: вышли за границу — зеркалим
 * смещение по этой оси, длина смещения при этом не меняется, значит враг
 * по-прежнему появляется ровно за краем видимости. Проверка контента не даёт
 * задать карту уже, чем полтора кольца (sim/map-types.ts), поэтому зеркала
 * всегда хватает; финальное прижатие к границам — страховка от данных,
 * пришедших мимо проверки.
 */
function resolveRingPoint(
  world: World,
  dirX: number,
  dirY: number,
  radius: number,
  out: { x: number; y: number },
): void {
  const bounds = world.config.bounds;
  const margin = BOUNDS_MARGIN_UNITS * world.config.unitScale;
  const limitX = Math.max(0, bounds.halfWidth - margin);
  const limitY = Math.max(0, bounds.halfHeight - margin);
  const px = world.player.x;
  const py = world.player.y;

  let offsetX = dirX * radius;
  let offsetY = dirY * radius;
  if (px + offsetX < -limitX || px + offsetX > limitX) offsetX = -offsetX;
  if (py + offsetY < -limitY || py + offsetY > limitY) offsetY = -offsetY;

  out.x = clampToBounds(px + offsetX, limitX);
  out.y = clampToBounds(py + offsetY, limitY);
}

/**
 * Унести отставшего врага вперёд по направлению движения игрока.
 *
 * Так давление сохраняется, а пул не забивается теми, кто безнадёжно отстал:
 * убивать их некому, догнать они не могут, но каждый тик занимают слот,
 * клетку сетки и время кадра (docs/26-stage2-plan.md, WP4.1).
 */
export function recycleEnemyForward(world: World, index: number): void {
  forwardDirection(world, direction);
  directionInArc(world.rng, direction.x, direction.y, FORWARD_ARC_SIN, direction);

  const radius =
    world.config.view.spawnRadius +
    world.rng.nextRange(0, SPAWN_JITTER_UNITS * world.config.unitScale);
  resolveRingPoint(world, direction.x, direction.y, radius, point);

  const enemies = world.enemies;
  enemies.x[index] = point.x;
  enemies.y[index] = point.y;
  // Предыдущая позиция переносится вместе с текущей: иначе рендер нарисует
  // росчерк через весь экран на один кадр.
  enemies.prevX[index] = point.x;
  enemies.prevY[index] = point.y;
  enemies.vx[index] = 0;
  enemies.vy[index] = 0;
  world.stats.enemiesRecycled++;
}

/**
 * Держит на поле заданное число врагов: убитый сразу заменяется новым.
 * Режим фиксированной нагрузки — нужен, когда сравниваются две сборки на
 * одном и том же профиле.
 */
export function createConstantPopulationSpawner(
  targetPopulation: number,
  weights: Partial<Record<EnemyPattern, number>> = DEFAULT_WEIGHTS,
): Spawner {
  return createPopulationSpawner(() => targetPopulation, weights);
}

export interface RampOptions {
  /** с чего начинаем */
  startPopulation: number;
  /** на сколько врагов в секунду растёт нагрузка */
  addPerSecond: number;
  /** потолок, дальше которого не растём */
  maxPopulation: number;
}

export const DEFAULT_RAMP: RampOptions = {
  startPopulation: 20,
  addPerSecond: 2,
  maxPopulation: 480,
};

/**
 * Плавно наращивает нагрузку по ходу прогона.
 *
 * Фиксированный профиль отвечает на вопрос «тянет ли устройство сто врагов»,
 * и если тянет — не говорит ничего о запасе. Нарастающая нагрузка отвечает на
 * более полезный вопрос: **на каком количестве врагов это устройство
 * ломается**. Точка перелома на таймлайне сравнима между устройствами и
 * показывает, сколько места остаётся под контент.
 */
export function createRampSpawner(
  options: RampOptions = DEFAULT_RAMP,
  weights: Partial<Record<EnemyPattern, number>> = DEFAULT_WEIGHTS,
): Spawner {
  return createPopulationSpawner(
    (world) =>
      Math.min(
        options.maxPopulation,
        options.startPopulation + Math.floor(world.stats.elapsedSec * options.addPerSecond),
      ),
    weights,
  );
}

/** Целевая популяция в конкретный момент — для подписи на экране. */
export function rampTargetAt(options: RampOptions, elapsedSec: number): number {
  return Math.min(
    options.maxPopulation,
    options.startPopulation + Math.floor(elapsedSec * options.addPerSecond),
  );
}

const DEFAULT_WEIGHTS: Partial<Record<EnemyPattern, number>> = {
  swarm: 7,
  chase: 2,
  kite_and_shoot: 1,
};

function createPopulationSpawner(
  targetFor: (world: World) => number,
  weights: Partial<Record<EnemyPattern, number>>,
): Spawner {
  return {
    update(world, _dtSec) {
      const target = targetFor(world);
      // Ограничение на спавн за тик: без него первый тик создаёт всю
      // популяцию разом и даёт выброс во времени кадра, который не имеет
      // отношения к устойчивому FPS.
      let budget = 8;
      while (world.enemies.aliveCount < target && budget-- > 0) {
        const typeIndex = pickWeightedType(world, weights);
        if (typeIndex < 0 || spawnRandomOnRing(world, typeIndex) < 0) return;
      }
    },
  };
}

/**
 * Взвешенный выбор типа по паттерну. Элиты пропускаются: их место — событие
 * таймлайна в назначенную минуту, а не случайность в потоке. Заодно это
 * держит профиль стенда испытаний сравнимым с замерами этапа 1.
 */
function pickWeightedType(world: World, weights: Partial<Record<EnemyPattern, number>>): number {
  let total = 0;
  for (const type of world.enemyTypes) {
    if (type.elite) continue;
    total += weights[type.pattern] ?? 0;
  }
  if (total <= 0) return world.enemyTypes.findIndex((type) => !type.elite);

  let roll = world.rng.nextFloat() * total;
  let last = -1;
  for (let i = 0; i < world.enemyTypes.length; i++) {
    if (world.enemyTypes[i].elite) continue;
    last = i;
    roll -= weights[world.enemyTypes[i].pattern] ?? 0;
    if (roll <= 0) return i;
  }
  return last;
}
