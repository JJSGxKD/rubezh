import type { BoostDef, LoadoutStat } from "@bh/shared-types";
import { LOADOUT_BOUNDS } from "./run-loadout";

/**
 * Бусты забега (docs/35-stage4-plan.md §3.5, Р39): из списка id в наборе на
 * забег — в эффекты, которые читает симуляция.
 *
 * Список приходит с устройства, поэтому незнакомый id и повтор отбрасываются,
 * а лишние сверх потолка — тоже: движок не даёт битому набору усилить забег
 * сильнее, чем позволяет контент. Сколько бустов оплачено, решает сервер.
 */

export interface RunBoosts {
  /** id применённых бустов — в порядке набора, без повторов */
  ids: string[];
  /** прибавки бустов к параметрам, сумма по всем */
  modifiers: Partial<Record<LoadoutStat, number>>;
  shieldHits: number;
  startLevels: number;
  extraOffers: number;
}

export const NO_BOOSTS: RunBoosts = { ids: [], modifiers: {}, shieldHits: 0, startLevels: 0, extraOffers: 0 };

export function resolveBoosts(types: readonly BoostDef[], ids: readonly string[], maxPerRun: number): RunBoosts {
  const byId = new Map(types.map((type) => [type.id, type]));
  const resolved: RunBoosts = { ids: [], modifiers: {}, shieldHits: 0, startLevels: 0, extraOffers: 0 };
  for (const id of ids) {
    if (resolved.ids.length >= maxPerRun) break;
    const type = byId.get(id);
    if (type === undefined || resolved.ids.includes(id)) continue;
    resolved.ids.push(id);
    for (const [stat, value] of Object.entries(type.modifiers ?? {}) as [LoadoutStat, number][]) {
      resolved.modifiers[stat] = (resolved.modifiers[stat] ?? 0) + value;
    }
    resolved.shieldHits += type.shieldHits ?? 0;
    resolved.startLevels += type.startLevels ?? 0;
    resolved.extraOffers += type.extraOffers ?? 0;
  }
  return resolved;
}

/**
 * Снаряжение и бусты вместе — одни и те же параметры (§3.3). Сумма упирается
 * в пределы движка: буст поверх полного набора не превращает забег в `NaN`
 * и не выходит за страховку от битых данных.
 */
export function combineModifiers(
  equipment: Readonly<Partial<Record<LoadoutStat, number>>>,
  boosts: Readonly<Partial<Record<LoadoutStat, number>>>,
): Partial<Record<LoadoutStat, number>> {
  const combined: Partial<Record<LoadoutStat, number>> = { ...equipment };
  for (const [stat, value] of Object.entries(boosts) as [LoadoutStat, number][]) {
    combined[stat] = Math.min((combined[stat] ?? 0) + value, LOADOUT_BOUNDS[stat]);
  }
  return combined;
}

/** Ошибки в данных бустов — для теста контента: какой буст и что не так. */
export function findBoostProblems(types: readonly BoostDef[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    if (seen.has(type.id)) problems.push(`${type.id}: id повторяется`);
    seen.add(type.id);
    const effects = Object.keys(type.modifiers ?? {}).length + (type.shieldHits ?? 0) + (type.startLevels ?? 0) + (type.extraOffers ?? 0);
    if (effects === 0) problems.push(`${type.id}: буст ничего не делает`);
    for (const [stat, value] of Object.entries(type.modifiers ?? {}) as [LoadoutStat, number][]) {
      if (!(stat in LOADOUT_BOUNDS)) problems.push(`${type.id}: неизвестный параметр ${stat}`);
      else if (!(value > 0 && value <= LOADOUT_BOUNDS[stat])) problems.push(`${type.id}.${stat}: от 0 до ${LOADOUT_BOUNDS[stat]}, а не ${value}`);
    }
    for (const field of ["shieldHits", "startLevels", "extraOffers"] as const) {
      const value = type[field];
      if (value !== undefined && !(Number.isInteger(value) && value > 0 && value <= 5)) problems.push(`${type.id}.${field}: целое от 1 до 5, а не ${value}`);
    }
  }
  return problems;
}
