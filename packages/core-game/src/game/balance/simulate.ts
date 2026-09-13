import type { DifficultyId } from "@bh/shared-types";
import { ENEMIES } from "../../content/enemies";
import { MAPS } from "../../content/maps";
import { findDifficulty } from "../../content/difficulty";
import { DROPS } from "../../content/drops";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../../content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../../content/waves";
import { WEAPONS } from "../../content/weapons";
import { chooseUpgrade, isAwaitingChoice } from "../progression/levels";
import { createTimelineDirector } from "../sim/director";
import { stepWorld } from "../sim/step";
import { createWorld, TICK_SEC } from "../sim/world";
import { createBot, type BotSkill } from "./bot";

/**
 * Прогон забега ботом на боевом контенте — вход калибровки баланса
 * (docs/26-stage2-plan.md, WP4.6).
 *
 * В отличие от тестов симуляции, которые гоняются на фикстурах, здесь взят
 * именно игровой контент: смысл в том, чтобы померить текущие числа, а не
 * поведение движка.
 */

/** Аварийный потолок: забег обязан кончиться, даже если бот неуязвим. */
const DEFAULT_MAX_SEC = 900;

export interface BalanceRunOptions {
  seed: number;
  skill: BotSkill;
  /** уровень сложности; по умолчанию — «Лёгкая»: коридоры калибровки заданы для неё */
  difficultyId?: DifficultyId;
  /** чем начинать забег; по умолчанию — первое стартовое оружие контента */
  startingWeaponId?: string;
  maxSec?: number;
}

export interface BalanceRunResult {
  seed: number;
  skill: BotSkill;
  startingWeaponId: string;
  survivalSec: number;
  level: number;
  /** отрезок таймлайна, до которого дожил — «волна» в аналитике */
  wave: number;
  enemiesKilled: number;
  xpCollected: number;
  peakEnemies: number;
  /** секунда, на которой бот взял второй уровень; 0 — не взял вовсе */
  firstLevelUpSec: number;
  /** забег упёрся в аварийный потолок, а не кончился смертью */
  timedOut: boolean;
}

export function simulateBalanceRun(options: BalanceRunOptions): BalanceRunResult {
  const difficulty = findDifficulty(options.difficultyId ?? "easy");
  const world = createWorld({
    seed: options.seed,
    enemies: ENEMIES,
    weapons: WEAPONS,
    passives: PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: LOADOUT_LIMITS,
    drops: DROPS,
    map: MAPS[0],
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(options.startingWeaponId === undefined
      ? {}
      : { startingWeaponId: options.startingWeaponId }),
  });
  const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
  const bot = createBot(options.skill);
  const maxTicks = Math.round((options.maxSec ?? DEFAULT_MAX_SEC) / TICK_SEC);

  let firstLevelUpSec = 0;
  let tick = 0;
  while (tick < maxTicks && world.player.alive) {
    // Выбор делается до шага: пока он не сделан, мир стоит, и цикл крутился бы
    // вхолостую до конца прогона.
    if (isAwaitingChoice(world)) {
      if (firstLevelUpSec === 0) firstLevelUpSec = world.stats.elapsedSec;
      chooseUpgrade(world, bot.choose(world.progression.offers));
      continue;
    }

    director.update(world, TICK_SEC);
    stepWorld(world, bot.input(world));
    tick++;
  }

  return {
    seed: options.seed,
    skill: options.skill,
    startingWeaponId: startingWeaponOf(world),
    survivalSec: world.stats.elapsedSec,
    level: world.progression.level,
    wave: world.difficulty.segment,
    enemiesKilled: world.stats.enemiesKilled,
    xpCollected: world.stats.xpCollected,
    peakEnemies: world.stats.peakEnemies,
    firstLevelUpSec,
    timedOut: world.player.alive,
  };
}

function startingWeaponOf(world: { loadout: { weapons: { typeIndex: number }[] }; weaponTypes: { id: string }[] }): string {
  const first = world.loadout.weapons[0];
  return first === undefined ? "" : world.weaponTypes[first.typeIndex].id;
}

/** Квантиль по уже отсортированному набору; линейная интерполяция не нужна. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index];
}

export interface BalanceSummary {
  runs: number;
  medianSurvivalSec: number;
  p10SurvivalSec: number;
  p90SurvivalSec: number;
  /** доля забегов, оборвавшихся до минуты, — «умер, не поняв, во что играет» */
  deathsBeforeMinuteRatio: number;
  medianLevel: number;
  medianWave: number;
  medianFirstLevelUpSec: number;
  timedOut: number;
}

export function summarizeRuns(results: readonly BalanceRunResult[]): BalanceSummary {
  const survival = results.map((run) => run.survivalSec).sort((a, b) => a - b);
  const levels = results.map((run) => run.level).sort((a, b) => a - b);
  const waves = results.map((run) => run.wave).sort((a, b) => a - b);
  const firstLevelUps = results.map((run) => run.firstLevelUpSec).sort((a, b) => a - b);

  return {
    runs: results.length,
    medianSurvivalSec: quantile(survival, 0.5),
    p10SurvivalSec: quantile(survival, 0.1),
    p90SurvivalSec: quantile(survival, 0.9),
    deathsBeforeMinuteRatio:
      results.length === 0
        ? 0
        : results.filter((run) => run.survivalSec < 60).length / results.length,
    medianLevel: quantile(levels, 0.5),
    medianWave: quantile(waves, 0.5),
    medianFirstLevelUpSec: quantile(firstLevelUps, 0.5),
    timedOut: results.filter((run) => run.timedOut).length,
  };
}
