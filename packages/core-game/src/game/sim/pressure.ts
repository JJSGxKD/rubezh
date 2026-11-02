import { LOADOUT_STATS, type DeviceClass, type PressureDef, type RunPressureResult, type RunPressureStart } from "@bh/shared-types";
import { computePlayerPower } from "./player-power";
import type { World } from "./world";

/**
 * Подстройка давления директора спавна под силу игрока и устройство
 * (docs/32-balance.md §2.7, Р131, Р67, Р183). Здесь — чистые функции: сила
 * превращается в уровень давления `L`, уровень — в три рычага, рычаги —
 * в числа отрезка. Директор лишь зовёт их на входе в отрезок.
 *
 * Подстройка работает, только если у набора забега есть уровень аккаунта и в
 * мир передан контент: нет одного из двух — все множители ровно единицы, сдвиги
 * нули, и забег побитово равен забегу без подстройки (стенд, боты калибровки,
 * забег разработчика, запись и снимок прошлых сборок).
 *
 * Детерминизм: только `+ − × /` и `Math.round`/`min`/`max`, без степеней, и ни
 * одного обращения к `world.rng`.
 */

/** Рычаги на уровне давления: множители и сдвиги, которые директор кладёт в мир. */
export interface PressureLevers {
  hpScale: number;
  damageScale: number;
  spawnScale: number;
  aliveScale: number;
  /** на сколько секунд раньше открываются ступени (минус — позже) */
  stageShiftSec: number;
  /** на сколько отрезков раньше приходят события элит кривой (минус — позже) */
  eliteLead: number;
  /** то же для боссов */
  bossLead: number;
}

/** Что директор передаёт подстройке из плана отрезка. */
export interface PressurePlanInput {
  maxAlive: number;
  hpMul: number;
  damageMul: number;
}

export function isPressureActive(world: World): boolean {
  return world.pressureRules !== null && world.runLoadout.accountLevel !== undefined;
}

/**
 * Уровень давления по силе: 1 — опорный игрок, меньше — мягче, больше — жёстче,
 * всё в пределах `minLevel`…`maxLevel`. Ниже опорного шкала своя (`spanDown`):
 * новичку становится мягче быстрее, чем сильному жёстче.
 */
export function pressureLevelOf(rules: PressureDef, total: number): number {
  const delta = total - rules.reference;
  const raw = delta >= 0 ? 1 + delta / rules.spanUp : 1 + delta / rules.spanDown;
  return Math.min(rules.maxLevel, Math.max(rules.minLevel, raw));
}

/**
 * Рычаги на уровне давления. Они несимметричны (Р183): слабее опорного
 * работают все (`levers.down`), сильнее — толпа и события, а здоровье и урон
 * почти не растут (`levers.up`), ступени вверх не сдвигаются вовсе.
 */
export function leversOf(rules: PressureDef, level: number): PressureLevers {
  const d = level - 1;
  const down = d < 0;
  const k = down ? rules.levers.down : rules.levers.up;
  // `|| 0` после округления: `Math.round(-0.3)` — минус ноль, а он не должен попасть в снимок и запись.
  return {
    hpScale: 1 + k.hp * d,
    damageScale: 1 + k.damage * d,
    spawnScale: 1 + k.spawn * d,
    aliveScale: 1 + k.alive * d,
    stageShiftSec: down ? Math.round(rules.levers.down.stageShiftSec * d) || 0 : 0,
    eliteLead: clampLead(Math.round(k.leadPerLevel * d), rules.leads.elite),
    bossLead: clampLead(Math.round(k.leadPerLevel * d), rules.leads.boss),
  };
}

function clampLead(lead: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, lead)) || 0;
}

function deviceClassOf(world: World): DeviceClass {
  return world.runLoadout.deviceClass ?? "standard";
}

/**
 * Пересчёт силы и сдвигов. Зовётся при создании мира и на входе в каждый
 * отрезок таймлайна, то есть раз в 30–60 секунд, а не в тик. Враг, уже
 * вышедший, не меняется: хп и урон фиксируются при спавне.
 */
export function refreshPressure(world: World): void {
  const rules = world.pressureRules;
  if (rules === null) return;

  const power = computePlayerPower(world, rules);
  const level = pressureLevelOf(rules, power.total);
  const levers = leversOf(rules, level);

  const difficulty = world.difficulty;
  difficulty.power = power.total;
  difficulty.pressureLevel = level;
  difficulty.spawnMul = levers.spawnScale;
  difficulty.stageShiftSec = levers.stageShiftSec;
  difficulty.eliteLead = levers.eliteLead;
  difficulty.bossLead = levers.bossLead;
}

/** Первый пересчёт при создании мира: его сила и уровень уходят в событие старта и в аналитику. */
export function initPressure(world: World): void {
  refreshPressure(world);
  world.difficulty.startPower = world.difficulty.power;
  world.difficulty.startPressure = world.difficulty.pressureLevel;
}

/**
 * Числа отрезка с подстройкой: здоровье, урон и потолок живых. Множители
 * перемножаются слева направо — отрезок, уровень сложности, масштаб подстройки,
 * добавка устройства: порядок умножения дробных чисел часть результата.
 *
 * Слабое устройство (Р67): потолок живых ниже; а если он урезал число врагов и
 * забег дошёл до `compensateFromSec`, недостающее добирают здоровье и урон.
 * Потолок пула (`config.maxEnemies`) режет число живых, но добавки не даёт —
 * это ограничение мира, а не устройства.
 */
export function applySegmentPressure(world: World, plan: PressurePlanInput): void {
  const rules = world.pressureRules;
  if (rules === null) return;

  const level = world.difficultyLevel;
  const levers = leversOf(rules, world.difficulty.pressureLevel);
  const devices = rules.devices;

  const desiredAlive = Math.round(plan.maxAlive * level.maxAliveMul * levers.aliveScale);
  const cap = devices.caps[deviceClassOf(world)];
  const deviceLimited = Math.min(desiredAlive, cap);

  let shortfall = 1;
  if (desiredAlive > cap && world.stats.elapsedSec >= devices.compensateFromSec) {
    shortfall = Math.min(devices.maxShortfall, desiredAlive / deviceLimited);
  }

  const difficulty = world.difficulty;
  difficulty.hpMul = plan.hpMul * level.enemyHpMul * levers.hpScale * (1 + devices.hpComp * (shortfall - 1));
  difficulty.damageMul = plan.damageMul * level.enemyDamageMul * levers.damageScale * (1 + devices.damageComp * (shortfall - 1));
  difficulty.maxAlive = Math.min(world.config.maxEnemies, deviceLimited);
}

function toHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Сила и давление на старте для события `started`; `undefined` — подстройки не было. */
export function describePressureStart(world: World): RunPressureStart | undefined {
  if (!isPressureActive(world)) return undefined;
  return {
    power: toHundredths(world.difficulty.startPower),
    level: toHundredths(world.difficulty.startPressure),
    deviceClass: deviceClassOf(world),
  };
}

/** То же плюс сила и давление на последнем пересчёте — для итога забега. */
export function describePressureResult(world: World): RunPressureResult | undefined {
  const start = describePressureStart(world);
  if (start === undefined) return undefined;
  return { ...start, powerEnd: toHundredths(world.difficulty.power), levelEnd: toHundredths(world.difficulty.pressureLevel) };
}

/** Предельные множители рычага на нижнем уровне: ниже этого враг или поток почти исчезают. */
const MIN_LEVER_FACTOR = 0.25;
/** Наименьший потолок слабого устройства: ниже поле пустеет настолько, что бой теряет смысл. */
const MIN_DEVICE_CAP = 60;
/** Потолки Р183: во сколько раз вверх здоровье и урон врагов растут у самого сильного игрока. */
const MAX_UP_HP_GAIN = 0.1;
const MAX_UP_DAMAGE_GAIN = 0.15;

const LOADOUT_STAT_SET: ReadonlySet<string> = new Set(LOADOUT_STATS);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Проверка контента подстройки: ошибка здесь не роняет забег, а тихо уводит его
 * в другой баланс. Сообщения называют поле целиком (`pressure.levers.up.hp`).
 */
export function findPressureProblems(def: PressureDef): string[] {
  const input: unknown = def;
  if (typeof input !== "object" || input === null) return ["pressure — раздел отсутствует"];

  const problems: string[] = [];
  const positive = (path: string, value: number): void => {
    if (!(isFiniteNumber(value) && value > 0)) problems.push(`pressure.${path} — больше 0, сейчас ${String(value)}`);
  };
  const nonNegative = (path: string, value: number): void => {
    if (!(isFiniteNumber(value) && value >= 0)) problems.push(`pressure.${path} — не меньше 0, сейчас ${String(value)}`);
  };

  positive("reference", def.reference);
  positive("spanUp", def.spanUp);
  positive("spanDown", def.spanDown);
  if (!(isFiniteNumber(def.minLevel) && def.minLevel > 0 && def.minLevel <= 1)) {
    problems.push(`pressure.minLevel — больше 0 и не больше 1: уровень 1 обязан лежать в пределах, сейчас ${String(def.minLevel)}`);
  }
  if (!(isFiniteNumber(def.maxLevel) && def.maxLevel >= 1)) {
    problems.push(`pressure.maxLevel — не меньше 1: уровень 1 обязан лежать в пределах, сейчас ${String(def.maxLevel)}`);
  }

  nonNegative("power.slotPoints", def.power.slotPoints);
  nonNegative("power.buildPoints", def.power.buildPoints);
  nonNegative("power.buildCap", def.power.buildCap);
  for (const [stat, weight] of Object.entries(def.power.gear)) {
    if (weight === undefined) continue;
    if (!LOADOUT_STAT_SET.has(stat)) problems.push(`pressure.power.gear.${stat} — неизвестный параметр снаряжения`);
    else nonNegative(`power.gear.${stat}`, weight);
  }
  problems.push(...findScheduleProblems(def.power.buildSchedule));

  const downSlopes = ["hp", "damage", "spawn", "alive"] as const;
  for (const key of [...downSlopes, "leadPerLevel"] as const) {
    nonNegative(`levers.down.${key}`, def.levers.down[key]);
    nonNegative(`levers.up.${key}`, def.levers.up[key]);
  }
  nonNegative("levers.down.stageShiftSec", def.levers.down.stageShiftSec);
  if (Object.prototype.hasOwnProperty.call(def.levers.up, "stageShiftSec")) {
    problems.push("pressure.levers.up.stageShiftSec — вверх ступени не сдвигаются (Р183): поле только у levers.down");
  }
  // Новичку множитель на нижнем уровне не должен упасть почти до нуля: хп, урон или поток исчезли бы.
  for (const key of downSlopes) {
    const factor = 1 + def.levers.down[key] * (def.minLevel - 1);
    if (isFiniteNumber(factor) && factor <= MIN_LEVER_FACTOR) {
      problems.push(`pressure.levers.down.${key} — на нижнем уровне множитель ${String(factor)}, а должен быть больше ${String(MIN_LEVER_FACTOR)}`);
    }
  }
  // Р183: вверх давление растёт толпой и событиями, а не «губкой».
  const upSpan = def.maxLevel - 1;
  if (def.levers.up.hp * upSpan > MAX_UP_HP_GAIN) {
    problems.push(
      `pressure.levers.up.hp — подстройка не должна делать из врага губку для сильного игрока: здоровье вырастает на ${String(def.levers.up.hp * upSpan)}, а предел ${String(MAX_UP_HP_GAIN)}`,
    );
  }
  if (def.levers.up.damage * upSpan > MAX_UP_DAMAGE_GAIN) {
    problems.push(
      `pressure.levers.up.damage — подстройка не должна делать из врага губку для сильного игрока: урон вырастает на ${String(def.levers.up.damage * upSpan)}, а предел ${String(MAX_UP_DAMAGE_GAIN)}`,
    );
  }

  for (const rank of ["elite", "boss"] as const) {
    const bounds = def.leads[rank];
    if (!(Number.isInteger(bounds.min) && Number.isInteger(bounds.max))) {
      problems.push(`pressure.leads.${rank} — пределы целые отрезки, сейчас ${String(bounds.min)}…${String(bounds.max)}`);
    } else if (bounds.min > bounds.max) {
      problems.push(`pressure.leads.${rank} — нижний предел ${String(bounds.min)} выше верхнего ${String(bounds.max)}`);
    }
  }

  const caps = def.devices.caps;
  if (!(isFiniteNumber(caps.light) && caps.light >= MIN_DEVICE_CAP)) {
    problems.push(`pressure.devices.caps.light — не меньше ${String(MIN_DEVICE_CAP)}, сейчас ${String(caps.light)}`);
  }
  if (!(isFiniteNumber(caps.standard) && caps.standard >= MIN_DEVICE_CAP)) {
    problems.push(`pressure.devices.caps.standard — не меньше ${String(MIN_DEVICE_CAP)}, сейчас ${String(caps.standard)}`);
  }
  if (caps.light > caps.standard) {
    problems.push(`pressure.devices.caps.light — не выше потолка обычного устройства ${String(caps.standard)}, сейчас ${String(caps.light)}`);
  }
  if (!(isFiniteNumber(def.devices.maxShortfall) && def.devices.maxShortfall >= 1)) {
    problems.push(`pressure.devices.maxShortfall — не меньше 1, сейчас ${String(def.devices.maxShortfall)}`);
  }
  nonNegative("devices.hpComp", def.devices.hpComp);
  nonNegative("devices.damageComp", def.devices.damageComp);
  nonNegative("devices.compensateFromSec", def.devices.compensateFromSec);
  return problems;
}

/** Расписание сборки: с нулевой секунды, секунды строго растут, доли не убывают и в пределах 0…1. */
function findScheduleProblems(schedule: readonly (readonly [number, number])[]): string[] {
  if (schedule.length === 0) return ["pressure.power.buildSchedule — нужна хотя бы одна точка"];

  const problems: string[] = [];
  if (schedule[0][0] !== 0) problems.push(`pressure.power.buildSchedule — первая точка на 0-й секунде, сейчас ${String(schedule[0][0])}`);
  schedule.forEach(([sec, share], i) => {
    if (!isFiniteNumber(sec) || !isFiniteNumber(share)) {
      problems.push(`pressure.power.buildSchedule[${String(i)}] — оба числа конечные`);
      return;
    }
    if (share < 0 || share > 1) problems.push(`pressure.power.buildSchedule[${String(i)}] — доля от 0 до 1, сейчас ${String(share)}`);
    if (i === 0) return;
    if (sec <= schedule[i - 1][0]) problems.push(`pressure.power.buildSchedule[${String(i)}] — секунды строго растут, сейчас ${String(sec)} после ${String(schedule[i - 1][0])}`);
    if (share < schedule[i - 1][1]) problems.push(`pressure.power.buildSchedule[${String(i)}] — доля не убывает, сейчас ${String(share)} после ${String(schedule[i - 1][1])}`);
  });
  return problems;
}
