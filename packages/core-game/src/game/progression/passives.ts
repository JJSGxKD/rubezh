import { PASSIVE_CATEGORIES, type PassiveCategory, type PassiveDef, type PlayerStat } from "@bh/shared-types";

/** Пассивка с проверенными уровнями. */
export interface PassiveType {
  id: string;
  nameKey: string;
  descriptionKey: string;
  category: PassiveCategory;
  stat: PlayerStat;
  op: "add" | "mul";
  weight: number;
  levels: number[];
}

/**
 * Итоговые характеристики игрока после применения пассивок. Множители лежат
 * рядом с абсолютными значениями сознательно: оружие спрашивает у игрока
 * «во сколько раз больше урона» и «сколько всего снарядов», а не пересчитывает
 * пассивки само.
 */
export interface PlayerStats {
  damageMul: number;
  cooldownMul: number;
  areaMul: number;
  projectileSpeedMul: number;
  durationMul: number;
  extraProjectiles: number;
  moveSpeedMul: number;
  maxHp: number;
  regenPerSec: number;
  pickupRadius: number;
  armor: number;
  /**
   * Сопротивление стихиям — доля урона и длительности состояния, которую
   * гасит игрок (`sim/player-status.ts`). Отдельными числами, а не массивом:
   * снимок забега переносит характеристики как набор чисел.
   */
  resistFire: number;
  resistCold: number;
  resistLightning: number;
  resistPoison: number;
}

/** База, к которой применяются пассивки: значения игрока без улучшений. */
export interface PlayerStatsBase {
  maxHp: number;
  pickupRadius: number;
}

/** Характеристики, которые пассивки задают множителем. */
const MULTIPLIER_STATS: Partial<Record<PlayerStat, keyof PlayerStats>> = {
  damage: "damageMul",
  cooldown: "cooldownMul",
  area: "areaMul",
  projectileSpeed: "projectileSpeedMul",
  duration: "durationMul",
  moveSpeed: "moveSpeedMul",
  pickupRadius: "pickupRadius",
  maxHp: "maxHp",
};

const MAX_PASSIVE_LEVELS = 12;

/** Какие сопротивления меняет пассивка: «всем стихиям» — все четыре сразу. */
const RESIST_STATS: Partial<Record<PlayerStat, readonly ResistKey[]>> = {
  resist: ["resistFire", "resistCold", "resistLightning", "resistPoison"],
  resistFire: ["resistFire"],
  resistCold: ["resistCold"],
  resistLightning: ["resistLightning"],
  resistPoison: ["resistPoison"],
};

type ResistKey = "resistFire" | "resistCold" | "resistLightning" | "resistPoison";

/**
 * Сопротивление с одной пассивки — не больше этого: потолок игрока
 * (`MAX_PLAYER_RESIST`) держит сумму, а здесь ловится опечатка «50» вместо
 * «0.5».
 */
const MAX_PASSIVE_RESIST = 0.9;

export function findPassiveContentProblems(defs: readonly PassiveDef[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const def of defs) {
    if (seen.has(def.id)) problems.push(`пассивка ${def.id}: id повторяется`);
    seen.add(def.id);

    if (def.levels.length === 0 || def.levels.length > MAX_PASSIVE_LEVELS) {
      problems.push(`пассивка ${def.id}: от 1 до ${MAX_PASSIVE_LEVELS} уровней`);
    }
    for (const value of def.levels) {
      if (!Number.isFinite(value)) {
        problems.push(`пассивка ${def.id}: значение уровня должно быть числом`);
      } else if (def.op === "mul" && value <= 0) {
        // Множитель ноль обнуляет характеристику навсегда, отрицательный —
        // выворачивает её наизнанку: и то и другое ломает забег молча.
        problems.push(`пассивка ${def.id}: множитель должен быть больше нуля`);
      } else if (def.op === "add" && def.stat === "projectiles" && !Number.isInteger(value)) {
        problems.push(`пассивка ${def.id}: дробное число снарядов не имеет смысла`);
      }
    }
    if (def.stat === "projectiles" && def.op !== "add") {
      problems.push(`пассивка ${def.id}: число снарядов задаётся только слагаемым`);
    }
    if (RESIST_STATS[def.stat] !== undefined) {
      // Сопротивление — доля, и умножать ноль бессмысленно: у игрока без
      // пассивок его нет.
      if (def.op !== "add") problems.push(`пассивка ${def.id}: сопротивление задаётся только слагаемым`);
      if (def.levels.some((value) => !(value > 0 && value <= MAX_PASSIVE_RESIST))) {
        problems.push(`пассивка ${def.id}: сопротивление — доля от 0 до ${MAX_PASSIVE_RESIST}`);
      }
    }
    // Контент приходит и из JSON админки: тип не спасает от опечатки в категории.
    if (!PASSIVE_CATEGORIES.includes(def.category)) {
      problems.push(`пассивка ${def.id}: категория ${String(def.category)} не из ${PASSIVE_CATEGORIES.join(", ")}`);
    }
  }
  return problems;
}

export function resolvePassiveTypes(defs: readonly PassiveDef[]): PassiveType[] {
  const problems = findPassiveContentProblems(defs);
  if (problems.length > 0) {
    throw new Error(`Некорректный контент пассивок:\n${problems.join("\n")}`);
  }

  return defs.map((def) => ({
    id: def.id,
    nameKey: def.nameKey,
    descriptionKey: def.descriptionKey,
    category: def.category,
    stat: def.stat,
    op: def.op,
    weight: def.weight ?? 1,
    levels: [...def.levels],
  }));
}

export function createBaseStats(base: PlayerStatsBase): PlayerStats {
  return {
    damageMul: 1,
    cooldownMul: 1,
    areaMul: 1,
    projectileSpeedMul: 1,
    durationMul: 1,
    extraProjectiles: 0,
    moveSpeedMul: 1,
    maxHp: base.maxHp,
    regenPerSec: 0,
    pickupRadius: base.pickupRadius,
    armor: 0,
    resistFire: 0,
    resistCold: 0,
    resistLightning: 0,
    resistPoison: 0,
  };
}

/**
 * Пересчитать характеристики целиком, а не менять их по шагу при каждом
 * улучшении. Значение уровня в контенте — итоговое, и пересчёт с нуля не даёт
 * накапливаться ошибке: три раза применённый множитель 1.1 — это 1.3 по
 * таблице, а не 1.331 от перемножения.
 */
export function computePlayerStats(
  base: PlayerStatsBase,
  types: readonly PassiveType[],
  levelByType: ReadonlyMap<number, number>,
): PlayerStats {
  const stats = createBaseStats(base);

  types.forEach((type, index) => {
    const level = levelByType.get(index) ?? 0;
    if (level <= 0) return;

    const value = type.levels[Math.min(level, type.levels.length) - 1];
    applyPassive(stats, type, value, base);
  });
  return stats;
}

function applyPassive(
  stats: PlayerStats,
  type: PassiveType,
  value: number,
  base: PlayerStatsBase,
): void {
  if (type.stat === "projectiles") {
    stats.extraProjectiles += value;
    return;
  }
  if (type.stat === "regenPerSec" || type.stat === "armor") {
    stats[type.stat === "armor" ? "armor" : "regenPerSec"] += value;
    return;
  }
  const resists = RESIST_STATS[type.stat];
  if (resists !== undefined) {
    for (const key of resists) stats[key] += value;
    return;
  }

  const key = MULTIPLIER_STATS[type.stat];
  if (key === undefined) return;

  if (key === "maxHp") {
    stats.maxHp = type.op === "add" ? base.maxHp + value : base.maxHp * value;
    return;
  }
  if (key === "pickupRadius") {
    stats.pickupRadius = type.op === "add" ? base.pickupRadius + value : base.pickupRadius * value;
    return;
  }
  stats[key] = type.op === "add" ? stats[key] + value : stats[key] * value;
}
