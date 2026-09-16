import {
  PASSIVE_CATEGORIES,
  type EnemyDef,
  type EnemyStageDef,
  type PassiveCategory,
  type PassiveDef,
  type UpgradeChange,
  type WeaponDef,
  type WeaponLevel,
} from "@bh/shared-types";
import { ENEMIES, ENEMY_STAGES, LOADOUT_LIMITS, PASSIVES, PATTERN_DEFAULTS, WEAPONS } from "@bh/core-game";

/**
 * Что показывает гайдбук — выборка из контента, без своих копий чисел.
 * Геймдизайнер правит врага или оружие в `content/*`, и гайдбук меняется
 * вместе с игрой: текст, разошедшийся с балансом, хуже отсутствующего.
 */

export type SpeedClass = "slow" | "medium" | "fast";

/**
 * Скорость словом: «90 единиц в секунду» игроку ничего не говорит. Пороги —
 * по скорости персонажа без улучшений: медленного врага легко обогнать, от
 * быстрого не убежать.
 */
export function speedClass(speed: number): SpeedClass {
  if (speed < 50) return "slow";
  if (speed < 85) return "medium";
  return "fast";
}

export interface GuideEnemy {
  def: EnemyDef;
  /** на кого распадается при смерти; `null` — не распадается */
  child: { def: EnemyDef; count: number } | null;
}

function toGuideEnemy(def: EnemyDef): GuideEnemy {
  if (def.pattern !== "splitter") return { def, child: null };
  const child = ENEMIES.find((enemy) => enemy.id === def.params.childEnemy);
  const count = def.params.childCount ?? PATTERN_DEFAULTS.splitter.childCount ?? 0;
  return { def, child: child === undefined || count === 0 ? null : { def: child, count } };
}

/** Обычные враги в порядке контента — примерно в том, в каком они приходят. */
export function regularEnemies(): GuideEnemy[] {
  return ENEMIES.filter((enemy) => enemy.rank === undefined).map(toGuideEnemy);
}

/** Элита и мини-боссы: приходят только событиями таймлайна. */
export function eliteEnemies(): GuideEnemy[] {
  return ENEMIES.filter((enemy) => enemy.rank !== undefined).map(toGuideEnemy);
}

/** Ступени врагов по порядку открытия: та же тварь, но матёрее. */
export function enemyStages(): EnemyStageDef[] {
  return [...ENEMY_STAGES];
}

export function startingWeapons(): WeaponDef[] {
  return WEAPONS.filter((weapon) => weapon.starting === true);
}

export function unlockableWeapons(): WeaponDef[] {
  return WEAPONS.filter((weapon) => weapon.starting !== true);
}

/**
 * Рост оружия с первого уровня до последнего — только то, что меняется:
 * строка «пробивает 1 → 1» ничего не объясняет.
 */
export function weaponGrowth(weapon: WeaponDef): UpgradeChange[] {
  const first = weapon.levels[0];
  const last = weapon.levels[weapon.levels.length - 1];
  if (first === undefined || last === undefined) return [];

  const fields: { key: keyof WeaponLevel; lowerIsBetter: boolean }[] = [
    { key: "damage", lowerIsBetter: false },
    { key: "cooldownSec", lowerIsBetter: true },
    { key: "projectiles", lowerIsBetter: false },
    { key: "pierce", lowerIsBetter: false },
    { key: "areaRadius", lowerIsBetter: false },
  ];

  return fields.flatMap(({ key, lowerIsBetter }) => {
    const from = first[key];
    const to = last[key];
    if (from === undefined || to === undefined || from === to) return [];
    return [{ labelKey: statLabelKey(weapon, key), from, to, format: "value" as const, lowerIsBetter }];
  });
}

/** Подпись поля — с уточнением поведения там, где у поля другой смысл. */
function statLabelKey(weapon: WeaponDef, key: keyof WeaponLevel): string {
  const specific = `upgrade.stat.${weapon.behavior}.${key}`;
  return SPECIFIC_LABELS.has(specific) ? specific : `upgrade.stat.${key}`;
}

const SPECIFIC_LABELS: ReadonlySet<string> = new Set([
  "upgrade.stat.orbit.projectiles",
  "upgrade.stat.orbit.cooldownSec",
  "upgrade.stat.aura.cooldownSec",
  "upgrade.stat.aura.areaRadius",
  "upgrade.stat.area_strike.projectiles",
]);

export interface GuideCategory {
  category: PassiveCategory;
  slots: number;
  passives: PassiveDef[];
}

/** Пассивки по категориям — в том же порядке и с теми же слотами, что в забеге. */
export function passiveCategories(): GuideCategory[] {
  return PASSIVE_CATEGORIES.map((category) => ({
    category,
    slots: LOADOUT_LIMITS.passives[category],
    passives: PASSIVES.filter((passive) => passive.category === category),
  }));
}

/** Эффект пассивки на первом и последнем уровне — в том же виде, что на карточке выбора. */
export function passiveRange(passive: PassiveDef): UpgradeChange | null {
  const from = passive.levels[0];
  const to = passive.levels[passive.levels.length - 1];
  if (from === undefined || to === undefined) return null;
  return {
    labelKey: `upgrade.stat.passive.${passive.stat}`,
    from,
    to,
    format: passive.op === "mul" ? "percent" : "plus",
    lowerIsBetter: passive.stat === "cooldown",
  };
}
