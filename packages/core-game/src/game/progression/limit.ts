import type { LimitDef, LoadoutStat, UpgradeOption } from "@bh/shared-types";
import type { World } from "../sim/world";
import { LOADOUT_BOUNDS } from "./run-loadout";
import { limitChanges } from "./upgrade-changes";

/**
 * «Предел» (docs/35-stage4-plan.md, Р130; tasks/T-0194): малые прибавки без
 * счёта, когда в наборе всё взято и прокачано. Здесь — чистые правила: что
 * предлагается и сколько прибавка даёт. Выбор карточек и их применение живут в
 * `levels.ts` рядом с остальными карточками уровня. Случайности здесь нет.
 */

/** Доля предела параметра, больше которой не может быть шаг одной карточки. */
const MAX_STEP_OF_BOUND = 0.05;

/**
 * Запас на двоичную дробь: 2,95 + 0,05 — это 3,0000000000000004, а предел
 * ровно 3 достижим, и запись из-за хвоста пропадала бы на шаг раньше.
 */
const EPSILON = 1e-9;

/** Запись «Предела», годная для выбора, с весом. */
export interface LimitCandidate {
  option: UpgradeOption;
  weight: number;
}

/** Прибавки к параметрам от набранных стопок — в шкале `LoadoutStat`. */
export function limitModifiers(
  stacks: readonly number[],
  defs: readonly LimitDef[],
): Partial<Record<LoadoutStat, number>> {
  const modifiers: Partial<Record<LoadoutStat, number>> = {};
  defs.forEach((def, index) => {
    const count = stacks[index] ?? 0;
    if (count <= 0) return;
    modifiers[def.stat] = (modifiers[def.stat] ?? 0) + def.step * count;
  });
  return modifiers;
}

/** Карточка записи: `stacksBefore` — сколько нажатий уже набрано. */
export function limitOption(def: LimitDef, stacksBefore: number): UpgradeOption {
  return {
    id: `limit:${def.id}`,
    kind: "limit",
    refId: def.id,
    level: stacksBefore + 1,
    nameKey: def.nameKey,
    descriptionKey: def.descriptionKey,
    changes: limitChanges(def, stacksBefore),
  };
}

/**
 * Записи, которые ещё есть смысл предлагать: после одной стопки параметр —
 * снаряжение, бусты и «Предел» вместе — не выходит за `LOADOUT_BOUNDS`.
 * Упёршаяся в предел запись выпадает из выбора: нажатие, которое ничего не
 * даёт, было бы обманом.
 */
export function limitCandidates(world: World): LimitCandidate[] {
  const candidates: LimitCandidate[] = [];
  world.limitTypes.forEach((def, index) => {
    const stacks = world.progression.limitStacks[index] ?? 0;
    const equipped = world.loadoutModifiers[def.stat] ?? 0;
    // Прибавки других записей на тот же параметр тоже занимают место до предела.
    const others = otherStepsOnStat(world, def, index);
    if (equipped + others + def.step * (stacks + 1) > LOADOUT_BOUNDS[def.stat] + EPSILON) return;
    candidates.push({ weight: def.weight ?? 1, option: limitOption(def, stacks) });
  });
  return candidates;
}

function otherStepsOnStat(world: World, def: LimitDef, index: number): number {
  let sum = 0;
  world.limitTypes.forEach((other, otherIndex) => {
    if (otherIndex !== index && other.stat === def.stat) sum += other.step * (world.progression.limitStacks[otherIndex] ?? 0);
  });
  return sum;
}

/** Ошибки в записях — для теста контента и создания мира: какая запись и что не так. */
export function findLimitProblems(defs: readonly LimitDef[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.id)) problems.push(`предел ${def.id}: id повторяется`);
    seen.add(def.id);

    const bound = Object.hasOwn(LOADOUT_BOUNDS, def.stat) ? LOADOUT_BOUNDS[def.stat] : undefined;
    if (bound === undefined) {
      problems.push(`предел ${def.id}: неизвестный параметр ${String(def.stat)}`);
    } else if (!(def.step > 0) || !Number.isFinite(def.step)) {
      problems.push(`предел ${def.id}: шаг больше нуля, сейчас ${def.step}`);
    } else if (def.step > bound * MAX_STEP_OF_BOUND + EPSILON) {
      problems.push(`предел ${def.id}: шаг ${def.step} больше ${MAX_STEP_OF_BOUND * 100}% предела параметра ${def.stat} (${bound})`);
    }
    if (def.weight !== undefined && !(def.weight > 0 && Number.isFinite(def.weight))) {
      problems.push(`предел ${def.id}: вес больше нуля, сейчас ${def.weight}`);
    }
  }
  return problems;
}
