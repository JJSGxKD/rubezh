import type { EnemyPattern } from "@bh/shared-types";
import { ENEMIES } from "../../src/content/enemies";
import { createWorld, DEFAULT_SIM_CONFIG, type World } from "../../src/game/sim/world";
import { stepWorld } from "../../src/game/sim/step";
import { createConstantPopulationSpawner } from "../../src/game/sim/spawner";
import { benchInput } from "../../src/game/bench/autopilot";

/**
 * Общая обвязка для прогонов симуляции в тестах. Сценарий ввода — функция от
 * номера тика, а не запись реального ввода: так один и тот же скрипт
 * воспроизводится где угодно (docs/17-testing-strategy.md §3.2).
 */
export interface ScriptedRunOptions {
  seed: number;
  ticks: number;
  population: number;
  /** бессмертный игрок для нагрузочных прогонов — см. комментарий ниже */
  immortalPlayer?: boolean;
  /**
   * Доли паттернов в популяции. По умолчанию — смесь стенда испытаний этапа 1
   * (рой, преследование, стрелок): на ней сравниваются сборки между собой.
   */
  weights?: Partial<Record<EnemyPattern, number>>;
}

/** Все паттерны сразу — нагрузка, которую создаёт игра, а не стенд этапа 1. */
export const ALL_PATTERNS_WEIGHTS: Record<EnemyPattern, number> = {
  swarm: 4,
  chase: 1,
  kite_and_shoot: 2,
  dash: 1,
  orbit: 2,
  exploder: 1,
  splitter: 1,
};

export interface ScriptedRunResult {
  world: World;
  /** свёртка состояния мира — точное сравнение двух прогонов одним числом */
  checksum: number;
}

export function runScripted(options: ScriptedRunOptions): ScriptedRunResult {
  const world = createWorld({
    seed: options.seed,
    enemies: ENEMIES,
    // Нагрузочный прогон меряет устойчивое состояние: если игрок умирает на
    // тридцатой секунде, дальше меряется мир без выстрелов — то есть не тот
    // мир, ради которого прогон затевался.
    config: options.immortalPlayer
      ? { player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 } }
      : undefined,
  });
  const spawner = createConstantPopulationSpawner(options.population, options.weights);

  for (let tick = 0; tick < options.ticks; tick++) {
    spawner.update(world, 1 / 60);
    stepWorld(world, benchInput(tick));
  }

  return { world, checksum: checksumWorld(world) };
}

/**
 * Свёртка позиций и статистики в 32-битное число. Сравнение точное, без
 * допусков: цель — заметить любое расхождение, а не оценить его величину.
 */
export function checksumWorld(world: World): number {
  let hash = 2166136261;
  const fold = (value: number): void => {
    hash = Math.imul(hash ^ Math.round(value * 1000), 16777619) | 0;
  };

  fold(world.player.x);
  fold(world.player.y);
  fold(world.player.hp);
  fold(world.stats.enemiesSpawned);
  fold(world.stats.enemiesKilled);
  fold(world.stats.damageTaken);
  fold(world.stats.shotsFired);
  fold(world.stats.deathCauseType);
  for (const kills of world.stats.killsByType) fold(kills);

  for (let i = 0; i < world.enemies.count; i++) {
    fold(world.enemies.alive[i]);
    if (world.enemies.alive[i] === 0) continue;
    fold(world.enemies.x[i]);
    fold(world.enemies.y[i]);
    fold(world.enemies.hp[i]);
    fold(world.enemies.phase[i]);
    fold(world.enemies.ringRadius[i]);
  }
  return hash;
}
