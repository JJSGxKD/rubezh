import type { EnemyPattern, WaveDef } from "@bh/shared-types";
import { spawnEnemy, type World } from "./world";

/**
 * Спавнер отделён от step(): у игрового забега и у стресс-прогона разные
 * правила появления врагов, а сама симуляция одна и та же. Для FPS-испытания
 * нужна стабильная популяция на экране, для игры — кривая волн из контента.
 */
export interface Spawner {
  update(world: World, dtSec: number): void;
}

/** Дистанция спавна за пределами видимой области. */
const SPAWN_RING_MARGIN = 80;

/**
 * Волны из контента: спавн по достижении секунды из waves.ts.
 * Порядок обхода спавнов фиксирован порядком в массиве — от него зависит
 * последовательность обращений к rng, а значит и воспроизводимость.
 */
export function createWaveSpawner(waves: readonly WaveDef[]): Spawner {
  const ordered = [...waves].sort((a, b) => a.second - b.second);
  let nextWave = 0;

  return {
    update(world, _dtSec) {
      while (nextWave < ordered.length && world.stats.elapsedSec >= ordered[nextWave].second) {
        const wave = ordered[nextWave];
        for (const spawn of wave.spawns) {
          const typeIndex = world.enemyTypes.findIndex((type) => type.id === spawn.enemy);
          if (typeIndex < 0) continue;
          for (let n = 0; n < spawn.count; n++) {
            spawnAtRing(world, typeIndex);
          }
        }
        nextWave++;
      }
    },
  };
}

/**
 * Держит на экране заданное число врагов: убитый сразу заменяется новым.
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
        if (typeIndex < 0 || spawnAtRing(world, typeIndex) < 0) return;
      }
    },
  };
}

function pickWeightedType(world: World, weights: Partial<Record<EnemyPattern, number>>): number {
  let total = 0;
  for (const type of world.enemyTypes) total += weights[type.pattern] ?? 0;
  if (total <= 0) return world.enemyTypes.length > 0 ? 0 : -1;

  let roll = world.rng.nextFloat() * total;
  for (let i = 0; i < world.enemyTypes.length; i++) {
    roll -= weights[world.enemyTypes[i].pattern] ?? 0;
    if (roll <= 0) return i;
  }
  return world.enemyTypes.length - 1;
}

/** Спавн на окружности вокруг игрока, за пределами видимой области. */
function spawnAtRing(world: World, typeIndex: number): number {
  const angle = world.rng.nextRange(0, Math.PI * 2);
  const radius =
    Math.hypot(world.config.width, world.config.height) / 2 +
    world.rng.nextRange(0, SPAWN_RING_MARGIN * world.config.unitScale);

  return spawnEnemy(
    world,
    typeIndex,
    world.player.x + Math.cos(angle) * radius,
    world.player.y + Math.sin(angle) * radius,
  );
}
