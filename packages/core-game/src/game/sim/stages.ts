import type { EnemyStageDef } from "@bh/shared-types";
import type { World } from "./world";

/**
 * Стейджи врагов: та же тварь, но матёрее (`content/stages.ts`).
 *
 * Ступень выбирается **в момент спавна** и дальше не меняется: враг, вышедший
 * на третьей минуте, не должен усиливаться задним числом вместе с таймлайном,
 * — ровно по той же причине, по которой урон живёт в пуле, а не в типе.
 *
 * Прежние ступени из потока не уходят: вес открытой ступени добавляется к
 * весам старых. Игрок должен узнавать крысу и на десятой минуте и при этом
 * видеть, что рядом с ней бежит совсем не та крыса, что в начале.
 */

export interface EnemyStage {
  fromSec: number;
  weight: number;
  hpMul: number;
  damageMul: number;
  speedMul: number;
  xpMul: number;
  nameKey: string | null;
}

/** Ступеней больше восьми не бывает: ступень хранится в Uint8Array пула. */
export const MAX_STAGES = 8;

const BASE_STAGE: EnemyStage = {
  fromSec: 0,
  weight: 1,
  hpMul: 1,
  damageMul: 1,
  speedMul: 1,
  xpMul: 1,
  nameKey: null,
};

export function resolveStages(defs: readonly EnemyStageDef[] | undefined): EnemyStage[] {
  if (defs === undefined || defs.length === 0) return [BASE_STAGE];
  return defs.slice(0, MAX_STAGES).map((def) => ({
    fromSec: def.fromSec,
    weight: def.weight,
    hpMul: def.hpMul,
    damageMul: def.damageMul,
    speedMul: def.speedMul,
    xpMul: def.xpMul,
    nameKey: def.nameKey ?? null,
  }));
}

/**
 * Какая ступень достанется врагу, выходящему сейчас. Выбор по весам среди
 * открытых: рулетка, а не «последняя открытая», — иначе прежние ступени
 * исчезли бы из потока в ту же секунду, когда открылась новая.
 */
export function pickStage(world: World): number {
  const stages = world.stages;
  const elapsed = world.stats.elapsedSec;

  let total = 0;
  let last = 0;
  for (let i = 0; i < stages.length; i++) {
    if (stages[i].fromSec > elapsed) break;
    total += stages[i].weight;
    last = i;
  }
  // Пока открыта одна ступень, выбирать не из чего — и генератор не
  // трогается вовсе: лишний бросок сдвинул бы всю последовательность забега.
  if (last === 0 || total <= 0) return 0;

  let roll = world.rng.nextRange(0, total);
  for (let i = 0; i <= last; i++) {
    roll -= stages[i].weight;
    if (roll < 0) return i;
  }
  return last;
}

/** Ступень живого врага. За границами набора — базовая: снимок мог прийти со ступенью, которой уже нет. */
export function stageOf(world: World, index: number): EnemyStage {
  return world.stages[world.enemies.stage[index]] ?? world.stages[0] ?? BASE_STAGE;
}

/**
 * Проверка контента ступеней: ошибки здесь стоят дорого — забег с ломаной
 * ступенью не падает, а тихо идёт не по тем числам.
 */
export function findStageProblems(defs: readonly EnemyStageDef[]): string[] {
  const problems: string[] = [];
  if (defs.length === 0) return problems;
  if (defs.length > MAX_STAGES) problems.push(`ступеней больше ${MAX_STAGES}: ступень хранится в Uint8Array пула`);
  if (defs[0].fromSec !== 0) problems.push("первая ступень должна открываться с нулевой секунды: до неё врагов не из чего собрать");

  for (let i = 0; i < defs.length; i++) {
    const stage = defs[i];
    const name = `ступень ${String(i + 1)}`;
    if (!(stage.weight > 0)) problems.push(`${name}: weight должен быть больше нуля, иначе ступень не приходит вовсе`);
    for (const field of ["hpMul", "damageMul", "speedMul", "xpMul"] as const) {
      if (!(stage[field] > 0)) problems.push(`${name}: ${field} должен быть больше нуля`);
    }
    if (i === 0) continue;

    const previous = defs[i - 1];
    if (stage.fromSec <= previous.fromSec) problems.push(`${name}: открывается не позже предыдущей (${String(stage.fromSec)} с)`);
    // Ступень не бывает слабее предыдущей ни по одной оси: иначе «матёрый»
    // враг оказывается подарком, и игрок не понимает, чего бояться.
    for (const field of ["hpMul", "damageMul", "speedMul", "xpMul"] as const) {
      if (stage[field] < previous[field]) problems.push(`${name}: ${field} меньше, чем у предыдущей (${String(stage[field])} против ${String(previous[field])})`);
    }
  }
  return problems;
}
