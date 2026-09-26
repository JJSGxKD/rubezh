import { LOADOUT_STATS, type LoadoutStat, type RunLoadout } from "@bh/shared-types";

/**
 * Набор на забег — модификаторы снаряжения, дерева и бустов
 * (docs/35-stage4-plan.md §3.3, WP7). Движок не знает, откуда они: он
 * получает готовый набор и складывает его с базой игрока до пассивок забега.
 *
 * Набор приходит с устройства — из подписанного снимка надетого или из
 * снимка прерванного забега. Подпись проверяет сервер, а движок только не
 * даёт битому набору превратить забег в `NaN`: неизвестное и нечисловое
 * отбрасывается, отрицательное — тоже (снаряжение не ослабляет), а слишком
 * большое срезается до предела.
 */

/**
 * Предел одной прибавки. Это страховка от битых данных, а не баланс: баланс
 * держат диапазоны свойств предметов на сервере. Предел стоит заметно выше
 * того, что даёт полный набор легендарных предметов, чтобы честный набор в
 * него не упирался никогда.
 */
export const LOADOUT_BOUNDS: Readonly<Record<LoadoutStat, number>> = {
  damage: 3,
  cooldown: 0.6,
  area: 2,
  projectileSpeed: 2,
  duration: 2,
  moveSpeed: 1,
  pickupRadius: 3,
  maxHp: 1000,
  regenPerSec: 20,
  armor: 20,
  resistFire: 0.9,
  resistCold: 0.9,
  resistLightning: 0.9,
  resistPoison: 0.9,
  damageFire: 3,
  damageCold: 3,
  damageLightning: 3,
  damagePoison: 3,
  statusChance: 2,
};

/** Бустов на забег не больше — и id буста не длиннее. */
export const MAX_LOADOUT_BOOSTS = 8;
const MAX_BOOST_ID = 64;

export const EMPTY_LOADOUT: RunLoadout = { modifiers: {}, boosts: [] };

export function sanitizeLoadout(input: unknown): RunLoadout {
  if (typeof input !== "object" || input === null) return { modifiers: {}, boosts: [] };
  const record = input as Record<string, unknown>;
  const rawModifiers = typeof record.modifiers === "object" && record.modifiers !== null ? (record.modifiers as Record<string, unknown>) : {};

  const modifiers: Partial<Record<LoadoutStat, number>> = {};
  for (const stat of LOADOUT_STATS) {
    const value = rawModifiers[stat];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    modifiers[stat] = Math.min(value, LOADOUT_BOUNDS[stat]);
  }

  const boosts = Array.isArray(record.boosts)
    ? record.boosts
        .filter((boost): boost is string => typeof boost === "string" && boost.length > 0 && boost.length <= MAX_BOOST_ID)
        .slice(0, MAX_LOADOUT_BOOSTS)
    : [];
  return { modifiers, boosts };
}

/** Прибавка параметра; не задана — ноль. */
export function loadoutValue(modifiers: Readonly<Partial<Record<LoadoutStat, number>>>, stat: LoadoutStat): number {
  return modifiers[stat] ?? 0;
}

/** Набор без модификаторов и бустов: в запись и снимок такой не пишется. */
export function isEmptyLoadout(loadout: RunLoadout): boolean {
  return Object.keys(loadout.modifiers).length === 0 && loadout.boosts.length === 0;
}
