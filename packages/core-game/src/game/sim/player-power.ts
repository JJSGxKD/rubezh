import { LOADOUT_STATS, PASSIVE_CATEGORIES, type PressureDef } from "@bh/shared-types";
import type { World } from "./world";

/**
 * Сила игрока: сколько «очков» он принёс в забег (docs/32-balance.md §2.7,
 * Р65, Р183). Чистая функция от мира: ни одного броска генератора, только
 * `+ − × /` и `Math.min`/`Math.max` — результат обязан совпасть на любом
 * JS-движке, потому что от него зависит исход забега.
 *
 * Слагаемых три. Бусты в силу не входят: буст — разовая покупка на забег, и
 * если он поднимает давление, игрок платит за то, что у него сразу отбирают.
 */

export interface PlayerPower {
  /** очки за открытые слоты: их открывает уровень аккаунта */
  slots: number;
  /** очки за прибавки снаряжения и дерева без бустов */
  gear: number;
  /** помощь отстающему набору: не выше нуля */
  build: number;
  /** сумма трёх слагаемых */
  total: number;
}

/** Средний максимальный уровень типов; пустой список — единица, чтобы ёмкость не стала нулём. */
function meanMaxLevel(types: readonly { levels: readonly unknown[] }[]): number {
  if (types.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < types.length; i++) sum += types[i].levels.length;
  return sum / types.length;
}

/**
 * Доля собранного набора от его ёмкости, от 0 до 1. Ёмкость — все слоты на
 * среднем максимальном уровне открытого: так считается «насколько набор полон»,
 * а не «сколько всего собрано».
 */
export function buildScoreOf(world: World): number {
  const limits = world.loadoutLimits;
  let passiveSlots = 0;
  for (const category of PASSIVE_CATEGORIES) passiveSlots += limits.passives[category];

  const capacity = limits.weapons * meanMaxLevel(world.weaponTypes) + passiveSlots * meanMaxLevel(world.passiveTypes);
  // Слотов нет вовсе: собирать нечего, набор «полон» — помощи отстающему не бывает.
  if (!(capacity > 0)) return 1;

  let levels = 0;
  for (const slot of world.loadout.weapons) levels += slot.level;
  for (const slot of world.loadout.passives) levels += slot.level;
  return Math.min(1, levels / capacity);
}

/**
 * Ожидаемая доля набора на секунде забега: ломаная по расписанию. До первой
 * точки — её значение, после последней — последнее.
 */
export function expectedBuildScore(schedule: readonly (readonly [number, number])[], sec: number): number {
  if (schedule.length === 0) return 0;
  if (sec <= schedule[0][0]) return schedule[0][1];
  for (let i = 1; i < schedule.length; i++) {
    const [toSec, toValue] = schedule[i];
    if (sec > toSec) continue;
    const [fromSec, fromValue] = schedule[i - 1];
    return fromValue + (toValue - fromValue) * ((sec - fromSec) / (toSec - fromSec));
  }
  return schedule[schedule.length - 1][1];
}

/**
 * Сила игрока по миру. Снаряжение берётся из набора забега до бустов
 * (`runLoadout.modifiers`), а не из итоговых модификаторов мира: те уже
 * сложены с прибавками бустов.
 */
export function computePlayerPower(world: World, rules: PressureDef): PlayerPower {
  const limits = world.loadoutLimits;
  const slots = rules.power.slotPoints * (limits.weapons + limits.passives.attack + limits.passives.defense + limits.passives.mobility);

  // Порядок перечня фиксирован: порядок сложения дробных чисел — часть результата.
  let gear = 0;
  const modifiers = world.runLoadout.modifiers;
  for (const stat of LOADOUT_STATS) {
    gear += (rules.power.gear[stat] ?? 0) * (modifiers[stat] ?? 0);
  }

  // Только помощь отстающему: набор впереди расписания давление не поднимает (Р183).
  // `|| 0` убирает минус ноль: в снимок и в запись он не должен попадать.
  const behind = rules.power.buildPoints * (buildScoreOf(world) - expectedBuildScore(rules.power.buildSchedule, world.stats.elapsedSec));
  const build = Math.min(0, Math.max(-rules.power.buildCap, behind)) || 0;

  return { slots, gear, build, total: slots + gear + build };
}
