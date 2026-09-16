import type { EnemyPattern, UpgradeOption } from "@bh/shared-types";
import { ENEMIES } from "../../src/content/enemies";
import { DROPS } from "../../src/content/drops";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../../src/content/upgrades";
import { WEAPONS } from "../../src/content/weapons";
import { chooseUpgrade, isAwaitingChoice } from "../../src/game/progression/levels";
import { createWorld, DEFAULT_SIM_CONFIG, type World } from "../../src/game/sim/world";
import { stepWorld } from "../../src/game/sim/step";
import { createConstantPopulationSpawner } from "../../src/game/sim/spawner";
import { benchInput } from "../../src/game/bench/autopilot";
import { checksumWorld } from "../../src/game/sim/checksum";

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
  /** чем начинать забег; по умолчанию — первое стартовое оружие контента */
  startingWeaponId?: string;
  /**
   * Как отвечать на выбор улучшения. По умолчанию берётся первый вариант:
   * сценарий должен быть воспроизводимым, а не «как повезёт».
   */
  choose?: (offers: readonly UpgradeOption[], tick: number) => string;
}

/** Все паттерны сразу — нагрузка, которую создаёт игра, а не стенд этапа 1. */
export const ALL_PATTERNS_WEIGHTS: Record<EnemyPattern, number> = {
  swarm: 4,
  chase: 1,
  kite_and_shoot: 2,
  dash: 1,
  orbit: 2,
  exploder: 1,
  rush: 2,
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
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    ...(options.startingWeaponId === undefined
      ? {}
      : { startingWeaponId: options.startingWeaponId }),
    // Нагрузочный прогон меряет устойчивое состояние: если игрок умирает на
    // тридцатой секунде, дальше меряется мир без выстрелов — то есть не тот
    // мир, ради которого прогон затевался.
    config: options.immortalPlayer
      ? { player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 } }
      : undefined,
  });
  const spawner = createConstantPopulationSpawner(options.population, options.weights);

  const choose = options.choose ?? ((offers) => offers[0].id);

  for (let tick = 0; tick < options.ticks; tick++) {
    // Выбор улучшения делается до шага: пока он не сделан, мир стоит, и
    // цикл крутился бы вхолостую до конца сценария.
    if (isAwaitingChoice(world)) chooseUpgrade(world, choose(world.progression.offers, tick));

    spawner.update(world, 1 / 60);
    stepWorld(world, benchInput(tick));
  }

  return { world, checksum: checksumWorld(world) };
}

/** Свёртка мира живёт в исходниках: ею же сверяет запись забега (sim/checksum.ts). */
export { checksumWorld } from "../../src/game/sim/checksum";
