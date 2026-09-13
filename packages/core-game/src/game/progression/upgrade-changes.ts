import type { UpgradeChange, WeaponBehavior } from "@bh/shared-types";
import type { WeaponType, ResolvedWeaponLevel } from "../weapons/weapon-types";
import type { PassiveType } from "./passives";

/**
 * Что даёт вариант выбора: строки «урон 6 → 7», «снаряды 1 → 2».
 *
 * Считается в движке, а не в интерфейсе: только движок знает, что у оберега
 * `projectiles` — число камней, а у ауры `cooldownSec` — период тика, и какие
 * поля уровня вообще влияют на поведение. Интерфейс получает готовые подписи
 * ключами i18n и числа в единицах контента.
 */

type WeaponField = keyof ResolvedWeaponLevel;

/**
 * Поля, которые поведение действительно использует. Остальные у него есть
 * формально (у ауры нет снарядов), и показывать их — вводить в заблуждение.
 */
const FIELDS_BY_BEHAVIOR: Record<WeaponBehavior, readonly WeaponField[]> = {
  projectile_nearest: ["damage", "cooldownSec", "projectiles", "pierce", "projectileSpeed", "ttlSec"],
  projectile_facing: ["damage", "cooldownSec", "projectiles", "pierce", "projectileSpeed", "ttlSec"],
  orbit: ["damage", "cooldownSec", "projectiles", "areaRadius", "projectileSpeed"],
  aura: ["damage", "cooldownSec", "areaRadius"],
  area_strike: ["damage", "cooldownSec", "projectiles", "areaRadius"],
};

/** Главные числа нового оружия: скорость и время полёта снаряда — детали. */
const HEADLINE_FIELDS: ReadonlySet<WeaponField> = new Set([
  "damage",
  "cooldownSec",
  "projectiles",
  "pierce",
  "areaRadius",
]);

/**
 * Поля, у которых подпись зависит от поведения: у оберега `projectiles` —
 * камни, у ауры `cooldownSec` — тик урона. Остальные подписываются одинаково.
 */
const BEHAVIOR_LABELS: Partial<Record<WeaponBehavior, readonly WeaponField[]>> = {
  orbit: ["projectiles", "cooldownSec", "projectileSpeed"],
  aura: ["cooldownSec", "areaRadius"],
  area_strike: ["projectiles"],
};

/** Поля в игровых единицах: при создании мира они умножены на плотность экрана. */
const SCALED: ReadonlySet<WeaponField> = new Set(["areaRadius", "projectileSpeed"]);

export function weaponChanges(
  type: WeaponType,
  fromLevel: number | null,
  toLevel: number,
  unitScale: number,
): UpgradeChange[] {
  const next = type.levels[toLevel - 1];
  const previous = fromLevel === null ? null : type.levels[fromLevel - 1];
  if (next === undefined) return [];

  const changes: UpgradeChange[] = [];
  for (const field of FIELDS_BY_BEHAVIOR[type.behavior]) {
    const to = unscale(field, next[field], unitScale);
    if (previous === null || previous === undefined) {
      // Пробивание ноль у нового оружия — не свойство, а его отсутствие.
      if (!HEADLINE_FIELDS.has(field) || (field === "pierce" && to === 0)) continue;
      changes.push(change(weaponLabel(type.behavior, field), null, to, "value", field === "cooldownSec"));
      continue;
    }

    const from = unscale(field, previous[field], unitScale);
    if (from === to) continue;
    changes.push(change(weaponLabel(type.behavior, field), from, to, "value", field === "cooldownSec"));
  }
  return changes;
}

export function passiveChanges(type: PassiveType, fromLevel: number | null, toLevel: number): UpgradeChange[] {
  const to = type.levels[toLevel - 1];
  if (to === undefined) return [];
  const from = fromLevel === null ? null : (type.levels[fromLevel - 1] ?? null);

  return [
    change(
      `upgrade.stat.passive.${type.stat}`,
      from,
      to,
      type.op === "mul" ? "percent" : "plus",
      type.stat === "cooldown",
    ),
  ];
}

/** Лечение запасного варианта — в процентах максимального здоровья. */
export function healChanges(healRatio: number): UpgradeChange[] {
  return [change("upgrade.stat.heal", null, round(healRatio * 100), "value", false)];
}

function weaponLabel(behavior: WeaponBehavior, field: WeaponField): string {
  const specific = BEHAVIOR_LABELS[behavior]?.includes(field) === true;
  return specific ? `upgrade.stat.${behavior}.${field}` : `upgrade.stat.${field}`;
}

function unscale(field: WeaponField, value: number, unitScale: number): number {
  return round(SCALED.has(field) ? value / unitScale : value);
}

/**
 * Два знака после запятой: деление на плотность экрана даёт хвосты вида
 * 69.99999, и «радиус 70 → 70» из-за них выглядел бы как изменение.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function change(
  labelKey: string,
  from: number | null,
  to: number,
  format: UpgradeChange["format"],
  lowerIsBetter: boolean,
): UpgradeChange {
  return { labelKey, from, to, format, lowerIsBetter };
}
