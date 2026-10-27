import type { DifficultyId, MapDef, RunLoadout } from "@bh/shared-types";
import { findDifficulty, DEFAULT_DIFFICULTY_ID } from "../content/difficulty";
import { BOOSTS, MAX_BOOSTS_PER_RUN } from "../content/boosts";
import { CONTINUE } from "../content/continue";
import { CHESTS } from "../content/chests";
import { DROPS } from "../content/drops";
import { ENEMIES } from "../content/enemies";
import { ENEMY_STAGES } from "../content/stages";
import { DEFAULT_MAP_ID, findMap, MAPS } from "../content/maps";
import { ACCOUNT_UNLOCKS, CARD_TOOL_RULES, CARD_TOOL_UNLOCKS } from "../content/unlocks";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "../content/upgrades";
import { ENDLESS_CURVE, TIMELINE } from "../content/waves";
import { WEAPONS } from "../content/weapons";
import { cardToolsAt, unlocksAt, weaponsOpenAt } from "./progression/unlocks";
import { createTimelineDirector } from "./sim/director";
import type { Spawner } from "./sim/spawner";
import { createWorld, type World } from "./sim/world";

/**
 * Мир обычного забега на боевом контенте. Одна функция на сцену и на повтор
 * забега по записи (docs/28-diagnostics.md §3.4): разойдись они хоть в одном
 * параметре мира — повтор честного забега показал бы «дефект детерминизма».
 */
export interface RunWorldOptions {
  seed: number;
  mapId: string;
  difficultyId: DifficultyId;
  /** по умолчанию — первое открытое оружие контента */
  startingWeaponId?: string;
  /** физических пикселей на игровую единицу: мир считается в них */
  unitScale: number;
  /**
   * Снаряжение, бусты и уровень аккаунта; без поля — забег без снаряжения.
   * Уровень решает, что в мире есть: закрытое оружие и навыки в него не
   * попадают вовсе, слоты — по уровню (docs/35-stage4-plan.md §3.13).
   */
  loadout?: RunLoadout;
}

export interface RunWorld {
  world: World;
  spawner: Spawner;
  map: MapDef;
}

export function createRunWorld(options: RunWorldOptions): RunWorld {
  const difficulty = findDifficulty(options.difficultyId) ?? findDifficulty(DEFAULT_DIFFICULTY_ID);
  const map = findMap(options.mapId) ?? findMap(DEFAULT_MAP_ID) ?? MAPS[0];
  // Без уровня — открыто всё: запись и снимок прошлой сборки, стенд, тесты.
  const level = options.loadout?.accountLevel;
  const open = level === undefined ? null : unlocksAt(ACCOUNT_UNLOCKS, level);
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
    continueRules: CONTINUE,
    boosts: BOOSTS,
    maxBoostsPerRun: MAX_BOOSTS_PER_RUN,
    // Без уровня зарядов нет: на этом наборе идут golden-тесты и запись прошлой сборки.
    ...(level === undefined ? {} : { cardTools: cardToolsAt(CARD_TOOL_UNLOCKS, level) }),
    cardRules: CARD_TOOL_RULES,
    map,
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(options.startingWeaponId === undefined ? {} : { startingWeaponId: options.startingWeaponId }),
    ...(options.loadout === undefined ? {} : { loadout: options.loadout }),
    config: { unitScale: options.unitScale },
  });
  return { world, spawner: createTimelineDirector(TIMELINE, ENDLESS_CURVE), map };
}
