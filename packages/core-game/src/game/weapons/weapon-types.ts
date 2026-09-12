import type { WeaponBehavior, WeaponDef, WeaponLevel } from "@bh/shared-types";

/**
 * Числа уровня оружия с заполненными умолчаниями. Один и тот же вид объекта у
 * всех уровней всех оружий — горячий цикл читает поля без проверок на
 * `undefined`.
 */
export interface ResolvedWeaponLevel {
  damage: number;
  cooldownSec: number;
  projectiles: number;
  pierce: number;
  areaRadius: number;
  projectileSpeed: number;
  ttlSec: number;
}

export interface WeaponType {
  id: string;
  behavior: WeaponBehavior;
  nameKey: string;
  descriptionKey: string;
  starting: boolean;
  weight: number;
  levels: ResolvedWeaponLevel[];
}

const NEUTRAL_LEVEL: ResolvedWeaponLevel = {
  damage: 0,
  cooldownSec: 0,
  projectiles: 1,
  pierce: 0,
  areaRadius: 0,
  projectileSpeed: 0,
  ttlSec: 0,
};

/**
 * Умолчания по поведению: оружию на готовом поведении достаточно указать урон
 * и перезарядку, остальное берётся отсюда.
 */
const BEHAVIOR_DEFAULTS: Record<WeaponBehavior, Partial<ResolvedWeaponLevel>> = {
  projectile_nearest: { projectiles: 1, pierce: 0, projectileSpeed: 520, ttlSec: 1.6 },
  projectile_facing: { projectiles: 2, pierce: 1, projectileSpeed: 640, ttlSec: 1.2 },
  // Орбита: `areaRadius` — радиус кольца, `projectileSpeed` — линейная
  // скорость по нему, `cooldownSec` — пауза между ударами одного орбитера.
  orbit: { projectiles: 1, areaRadius: 70, projectileSpeed: 140, ttlSec: 0 },
  // Аура бьёт всех в радиусе раз в `cooldownSec`.
  aura: { projectiles: 1, areaRadius: 80 },
  area_strike: { projectiles: 1, areaRadius: 70 },
};

/** Поля в игровых единицах — пересчитываются под плотность экрана. */
const SCALED_FIELDS: readonly (keyof ResolvedWeaponLevel)[] = [
  "areaRadius",
  "projectileSpeed",
];

const MAX_PROJECTILES_PER_SHOT = 24;

/**
 * Проблемы контента оружия человеческим языком. Тот же валидатор работает в
 * тесте контента и при создании мира — как у врагов
 * (`game/patterns/enemy-types.ts`).
 */
export function findWeaponContentProblems(defs: readonly WeaponDef[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const def of defs) {
    if (seen.has(def.id)) problems.push(`оружие ${def.id}: id повторяется`);
    seen.add(def.id);

    if (BEHAVIOR_DEFAULTS[def.behavior] === undefined) {
      problems.push(`оружие ${def.id}: поведение ${String(def.behavior)} не реализовано`);
      continue;
    }
    if (def.levels.length === 0) {
      problems.push(`оружие ${def.id}: нет ни одного уровня`);
      continue;
    }
    problems.push(...findLevelProblems(def));
  }

  // Пустой список — законный случай: так гоняются тесты паттернов врагов,
  // где атака игрока только мешает. А вот набор оружия без единого
  // стартового означает забег, который начинается без атаки вовсе.
  if (defs.length > 0 && !defs.some((def) => def.starting === true)) {
    problems.push("нет ни одного стартового оружия");
  }
  return problems;
}

function findLevelProblems(def: WeaponDef): string[] {
  const problems: string[] = [];

  def.levels.forEach((level: WeaponLevel, index) => {
    const at = `оружие ${def.id}, уровень ${index + 1}`;
    if (!(level.damage > 0)) problems.push(`${at}: damage должен быть больше нуля`);
    if (!(level.cooldownSec > 0)) problems.push(`${at}: cooldownSec должен быть больше нуля`);

    const projectiles = level.projectiles;
    if (projectiles !== undefined) {
      const valid = Number.isInteger(projectiles) && projectiles >= 1 && projectiles <= MAX_PROJECTILES_PER_SHOT;
      if (!valid) problems.push(`${at}: projectiles — целое от 1 до ${MAX_PROJECTILES_PER_SHOT}`);
    }
    if (level.pierce !== undefined && (!Number.isInteger(level.pierce) || level.pierce < 0)) {
      problems.push(`${at}: pierce — целое не меньше нуля`);
    }
    for (const key of ["areaRadius", "projectileSpeed", "ttlSec"] as const) {
      const value = level[key];
      if (value !== undefined && !(value > 0)) problems.push(`${at}: ${key} должен быть больше нуля`);
    }
  });

  return problems;
}

/**
 * Разложить контент оружия в плоские уровни. Бросает на невалидном контенте:
 * ошибка при старте дешевле странного поведения в забеге.
 */
export function resolveWeaponTypes(defs: readonly WeaponDef[], unitScale: number): WeaponType[] {
  const problems = findWeaponContentProblems(defs);
  if (problems.length > 0) {
    throw new Error(`Некорректный контент оружия:\n${problems.join("\n")}`);
  }

  return defs.map((def) => ({
    id: def.id,
    behavior: def.behavior,
    nameKey: def.nameKey,
    descriptionKey: def.descriptionKey,
    starting: def.starting === true,
    weight: def.weight ?? 1,
    levels: def.levels.map((level) => resolveLevel(def.behavior, level, unitScale)),
  }));
}

function resolveLevel(
  behavior: WeaponBehavior,
  level: WeaponLevel,
  unitScale: number,
): ResolvedWeaponLevel {
  const resolved: ResolvedWeaponLevel = {
    ...NEUTRAL_LEVEL,
    ...BEHAVIOR_DEFAULTS[behavior],
    ...stripUndefined(level),
  };
  for (const key of SCALED_FIELDS) resolved[key] *= unitScale;
  return resolved;
}

/**
 * Явно заданное `undefined` в контенте не должно затирать умолчание
 * поведения — иначе оружие теряет скорость снаряда и он повисает на месте.
 */
function stripUndefined(level: WeaponLevel): Partial<ResolvedWeaponLevel> {
  const result: Partial<ResolvedWeaponLevel> = {};
  for (const [key, value] of Object.entries(level)) {
    if (typeof value === "number") result[key as keyof ResolvedWeaponLevel] = value;
  }
  return result;
}
