import type { DifficultyId, MapDef, RunLoadout } from "@bh/shared-types";
import { DEFAULT_DIFFICULTY_ID } from "../content/difficulty";
import { CONTENT_SNAPSHOT, type ContentSnapshot } from "../content/snapshot";
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
  /**
   * Контент забега; без поля — боевой `CONTENT_SNAPSHOT`. Песочница редактора
   * баланса подаёт сюда черновик (docs/19-content-admin.md §3).
   */
  content?: ContentSnapshot;
}

export interface RunWorld {
  world: World;
  spawner: Spawner;
  map: MapDef;
}

export function createRunWorld(options: RunWorldOptions): RunWorld {
  const content = options.content ?? CONTENT_SNAPSHOT;
  const difficulties = content.difficulties;
  const difficulty =
    difficulties.find((level) => level.id === options.difficultyId) ??
    difficulties.find((level) => level.id === DEFAULT_DIFFICULTY_ID);
  const map = content.maps.find((candidate) => candidate.id === options.mapId) ?? content.maps[0];
  // Без уровня — открыто всё: запись и снимок прошлой сборки, стенд, тесты.
  const level = options.loadout?.accountLevel;
  const open = level === undefined ? null : unlocksAt(content.accountUnlocks, level);
  const world = createWorld({
    seed: options.seed,
    enemies: content.enemies,
    stages: content.stages,
    weapons: open === null ? content.weapons : weaponsOpenAt(content.weapons, open),
    passives: open === null ? content.passives : content.passives.filter((passive) => open.passives.has(passive.id)),
    levelCurve: content.levelCurve,
    loadoutLimits: open?.limits ?? content.loadoutLimits,
    drops: content.drops,
    chests: content.chests,
    continueRules: content.continueRules,
    boosts: content.boosts,
    maxBoostsPerRun: content.maxBoostsPerRun,
    // Без уровня зарядов нет: на этом наборе идут golden-тесты и запись прошлой сборки.
    ...(level === undefined ? {} : { cardTools: cardToolsAt(content.cardToolUnlocks, level) }),
    cardRules: content.cardToolRules,
    map,
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(options.startingWeaponId === undefined ? {} : { startingWeaponId: options.startingWeaponId }),
    ...(options.loadout === undefined ? {} : { loadout: options.loadout }),
    config: { unitScale: options.unitScale },
  });
  return { world, spawner: createTimelineDirector(content.timeline, content.endlessCurve), map };
}
