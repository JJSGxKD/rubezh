import type { DifficultyId } from "@bh/shared-types";
import { ENEMIES } from "../../content/enemies";
import { ENEMY_STAGES } from "../../content/stages";
import { MAPS } from "../../content/maps";
import { DEFAULT_DIFFICULTY_ID, findDifficulty } from "../../content/difficulty";
import { CHESTS } from "../../content/chests";
import { DROPS } from "../../content/drops";
import { ACCOUNT_UNLOCKS } from "../../content/unlocks";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../../content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../../content/waves";
import { WEAPONS } from "../../content/weapons";
import { chooseUpgrade, isAwaitingChoice } from "../progression/levels";
import { unlocksAt, weaponsOpenAt } from "../progression/unlocks";
import { createTimelineDirector } from "../sim/director";
import { stepWorld } from "../sim/step";
import { DEFAULT_SIM_CONFIG } from "../sim/create-world";
import { createWorld, TICK_SEC } from "../sim/world";
import { createBot, type BotSkill, type DodgingBotOptions } from "./bot";

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
  /**
   * уровень сложности; по умолчанию — «Сложная»: главный бой, коридоры
   * калибровки заданы для неё; обучающая «Лёгкая» меряется отдельно
   */
  difficultyId?: DifficultyId;
  /** чем начинать забег; по умолчанию — первое открытое оружие контента */
  startingWeaponId?: string;
  /**
   * Уровень аккаунта: открытое оружие, навыки и слоты — как в забеге
   * (docs/35-stage4-plan.md §3.13). Не задан — открыто всё: на этом наборе
   * заданы коридоры калибровки.
   */
  accountLevel?: number;
  maxSec?: number;
  /**
   * Зонд давления: игрок почти неуязвим, и бот идёт до `maxSec`, а не до
   * смерти — так видно, сколько урона несёт поздний бой, до которого
   * настоящий бот не доживает.
   */
  immortalPlayer?: boolean;
  /** параметры уклоняющегося бота для замера по сетке; не заданы — `DODGING_BOT_DEFAULTS` */
  bot?: Partial<DodgingBotOptions>;
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
  /** сколько сундуков выпало за забег */
  chestsFound: number;
  /** сколько сундуков бот открыл за забег */
  chestsOpened: number;
  /** сколько слотов оружия к концу забега заняли эволюции */
  evolutions: number;
  /** забег упёрся в аварийный потолок, а не кончился смертью */
  timedOut: boolean;
  /** урон, полученный за каждую полную минуту забега; неполная последняя в массив не входит */
  damageTakenByMinute: number[];
}

export function simulateBalanceRun(options: BalanceRunOptions): BalanceRunResult {
  const difficulty = findDifficulty(options.difficultyId ?? DEFAULT_DIFFICULTY_ID);
  const open = options.accountLevel === undefined ? null : unlocksAt(ACCOUNT_UNLOCKS, options.accountLevel);
  const world = createWorld({
    seed: options.seed,
    enemies: ENEMIES,
    stages: ENEMY_STAGES,
    weapons: open === null ? WEAPONS : weaponsOpenAt(WEAPONS, open),
    passives: open === null ? PASSIVES : PASSIVES.filter((passive) => open.passives.has(passive.id)),
    levelCurve: LEVEL_CURVE,
    loadoutLimits: open?.limits ?? LOADOUT_LIMITS,
    drops: DROPS,
    chests: CHESTS,
    map: MAPS[0],
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(options.startingWeaponId === undefined
      ? {}
      : { startingWeaponId: options.startingWeaponId }),
    // Здоровье на миллион, как в нагрузочных прогонах: игрок не умирает, но
    // каждое попадание по-прежнему считается в `damageTaken`.
    ...(options.immortalPlayer === true
      ? { config: { player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 } } }
      : {}),
  });
  const director = createTimelineDirector(TIMELINE, ENDLESS_CURVE);
  const bot = createBot(options.skill, options.bot);
  const maxTicks = Math.round((options.maxSec ?? DEFAULT_MAX_SEC) / TICK_SEC);

  const damageTakenByMinute: number[] = [];
  let damageAtMinuteStart = 0;
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

    // Минута закрывается, когда забег её прошёл целиком: урон считается по
    // границам, а не по таймеру внутри мира.
    if (Math.floor(world.stats.elapsedSec / 60) > damageTakenByMinute.length) {
      damageTakenByMinute.push(world.stats.damageTaken - damageAtMinuteStart);
      damageAtMinuteStart = world.stats.damageTaken;
    }
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
    chestsFound: world.stats.chestsFound,
    chestsOpened: world.stats.chestsOpened,
    evolutions: world.loadout.weapons.filter((slot) => world.weaponTypes[slot.typeIndex]?.evolvedFrom !== undefined).length,
    timedOut: world.player.alive,
    damageTakenByMinute,
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
  /** медиана открытых сундуков за забег */
  medianChestsOpened: number;
  /** медиана слотов оружия, занятых эволюциями к концу забега */
  medianEvolutions: number;
  timedOut: number;
}

export function summarizeRuns(results: readonly BalanceRunResult[]): BalanceSummary {
  const survival = results.map((run) => run.survivalSec).sort((a, b) => a - b);
  const levels = results.map((run) => run.level).sort((a, b) => a - b);
  const waves = results.map((run) => run.wave).sort((a, b) => a - b);
  const firstLevelUps = results.map((run) => run.firstLevelUpSec).sort((a, b) => a - b);
  const chests = results.map((run) => run.chestsOpened).sort((a, b) => a - b);
  const evolutions = results.map((run) => run.evolutions).sort((a, b) => a - b);

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
    medianChestsOpened: quantile(chests, 0.5),
    medianEvolutions: quantile(evolutions, 0.5),
    timedOut: results.filter((run) => run.timedOut).length,
  };
}
