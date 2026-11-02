import type { DeviceClass, DifficultyDef, EnemyStageDef, LoadoutLimits, LoadoutStat, PressureDef, RunLoadout } from "@bh/shared-types";
import { BOOSTS } from "../../src/content/boosts";
import { ENEMIES } from "../../src/content/enemies";
import { MAPS } from "../../src/content/maps";
import { LEVEL_CURVE, PASSIVES } from "../../src/content/upgrades";
import { WEAPONS } from "../../src/content/weapons";
import { createRunWorld } from "../../src/game/run-world";
import { createWorld, DEFAULT_SIM_CONFIG, type SimConfig, type World } from "../../src/game/sim/world";

/**
 * Числа подстройки для тестов: двоично-точные (степени двойки и их суммы),
 * чтобы ожидания считались без округлений и сравнивались через `toBe`.
 */
export const TEST_PRESSURE: PressureDef = {
  power: {
    slotPoints: 0.25,
    gear: { damage: 1, maxHp: 0.0625 },
    buildPoints: 1,
    buildCap: 0.5,
    buildSchedule: [
      [0, 0],
      [100, 0.5],
      [200, 1],
    ],
  },
  reference: 1.25,
  spanUp: 2,
  spanDown: 1,
  minLevel: 0.75,
  maxLevel: 1.5,
  levers: {
    down: { hp: 1, damage: 0.5, spawn: 0.5, alive: 0.5, stageShiftSec: 100, leadPerLevel: 4 },
    up: { hp: 0.125, damage: 0.25, spawn: 1, alive: 0.5, leadPerLevel: 4 },
  },
  leads: { elite: { min: -1, max: 1 }, boss: { min: 0, max: 1 } },
  devices: {
    caps: { standard: 400, light: 100 },
    compensateFromSec: 60,
    hpComp: 0.5,
    damageComp: 0.5,
    maxShortfall: 2,
  },
};

/** Слоты «опорного» игрока: 2 оружия и по одному навыку — 5 слотов, 1,25 очка при весе 0,25. */
export const REFERENCE_LIMITS: LoadoutLimits = { weapons: 2, passives: { attack: 1, defense: 1, mobility: 1 } };

export interface PressureWorldOptions {
  seed?: number;
  limits?: LoadoutLimits;
  modifiers?: Partial<Record<LoadoutStat, number>>;
  boosts?: string[];
  /** `null` — набор без уровня аккаунта (подстройка выключена); по умолчанию уровень 5 */
  accountLevel?: number | null;
  deviceClass?: DeviceClass;
  /** `null` — мир без контента подстройки; по умолчанию `TEST_PRESSURE` */
  pressure?: PressureDef | null;
  /** секунда забега, с которой мир начинает: подстройка пересчитывается на входе в отрезок */
  elapsedSec?: number;
  difficulty?: DifficultyDef;
  stages?: readonly EnemyStageDef[];
  /** без оружия персонаж не атакует и набор пуст: так проверяется деление на ноль */
  noTypes?: boolean;
  config?: Partial<SimConfig>;
}

/**
 * Мир на боевом контенте врагов, оружия и навыков с заданными слотами,
 * снаряжением и подстройкой. Директор не создаётся: тесты зовут функции
 * подстройки напрямую или ставят свой директор.
 */
export function makePressureWorld(options: PressureWorldOptions = {}): World {
  const accountLevel = options.accountLevel === undefined ? 5 : options.accountLevel;
  const loadout: RunLoadout = {
    modifiers: options.modifiers ?? {},
    boosts: options.boosts ?? [],
    ...(accountLevel === null ? {} : { accountLevel }),
    ...(options.deviceClass === undefined ? {} : { deviceClass: options.deviceClass }),
  };
  const pressure = options.pressure === undefined ? TEST_PRESSURE : options.pressure;
  const world = createWorld({
    seed: options.seed ?? 1,
    enemies: ENEMIES,
    weapons: options.noTypes === true ? [] : WEAPONS,
    passives: options.noTypes === true ? [] : PASSIVES,
    levelCurve: LEVEL_CURVE,
    loadoutLimits: options.limits ?? REFERENCE_LIMITS,
    boosts: BOOSTS,
    map: MAPS[0],
    loadout,
    ...(pressure === null ? {} : { pressure }),
    ...(options.difficulty === undefined ? {} : { difficulty: options.difficulty }),
    ...(options.stages === undefined ? {} : { stages: options.stages }),
    config: {
      progressionEnabled: false,
      // Бессмертный: проверяются множители отрезка и спавн, а не то, сколько проживёт неподвижная мишень.
      player: { ...DEFAULT_SIM_CONFIG.player, maxHp: 1_000_000 },
      ...options.config,
    },
  });
  if (options.elapsedSec !== undefined) world.stats.elapsedSec = options.elapsedSec;
  return world;
}

/**
 * Набор «средний» из ориентиров задачи: шесть редких предметов 10-го уровня
 * (литерал из `item-rules`).
 */
export const MEDIUM_GEAR: Partial<Record<LoadoutStat, number>> = {
  damage: 0.1072,
  cooldown: 0.0714,
  area: 0.143,
  statusChance: 0.0893,
  damageFire: 0.0893,
  damageCold: 0.0893,
  maxHp: 21.44,
  armor: 1.0718,
  regenPerSec: 0.3572,
  pickupRadius: 0.2144,
  moveSpeed: 0.0357,
};

/** Набор «полный арсенал» из ориентиров задачи: шесть легендарных предметов 19-го уровня. */
export const FULL_GEAR: Partial<Record<LoadoutStat, number>> = {
  damage: 0.262,
  cooldown: 0.1748,
  area: 0.3494,
  projectileSpeed: 0.4368,
  duration: 0.3494,
  statusChance: 0.4368,
  damageFire: 0.2184,
  damageCold: 0.2184,
  damageLightning: 0.2184,
  damagePoison: 0.2184,
  maxHp: 52.42,
  armor: 2.6208,
  regenPerSec: 1.3104,
  resistFire: 0.262,
  resistCold: 0.262,
  pickupRadius: 0.5242,
  moveSpeed: 0.0874,
};

/** Мир обычного забега на боевом контенте `PRESSURE`: то, что видит игрок. */
export function makeContentWorld(accountLevel: number, modifiers: Partial<Record<LoadoutStat, number>>, boosts: string[] = []): World {
  return createRunWorld({
    seed: 1,
    mapId: "",
    difficultyId: "hard",
    unitScale: 2,
    loadout: { modifiers, boosts, accountLevel },
  }).world;
}
