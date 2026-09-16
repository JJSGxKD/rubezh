import type { EnemyDef, EnemyPattern } from "@bh/shared-types";

/**
 * Возможности паттерна — то, что зависит от поведения, а не от конкретного
 * врага. Радиус не задаётся в контенте: геймдизайнер оперирует hp, скоростью
 * и уроном, а размер — свойство хитбокса, привязанное к поведению.
 *
 * `contactDamage` — данные, а не проверка имени паттерна в шаге симуляции:
 * каждое `if (pattern === ...)` в игровой логике — сигнал, что параметр не
 * вынесен в данные (docs/15-engineering-standards.md §1, принцип 4).
 */
export interface PatternTraits {
  /** радиус хитбокса в игровых единицах */
  radius: number;
  /** бьёт ли касанием; стрелок и подрывник наносят урон иначе */
  contactDamage: boolean;
}

export const PATTERN_TRAITS: Record<EnemyPattern, PatternTraits> = {
  swarm: { radius: 7, contactDamage: true },
  chase: { radius: 12, contactDamage: true },
  kite_and_shoot: { radius: 9, contactDamage: false },
  dash: { radius: 10, contactDamage: true },
  orbit: { radius: 8, contactDamage: true },
  exploder: { radius: 9, contactDamage: false },
  splitter: { radius: 13, contactDamage: true },
  rush: { radius: 6, contactDamage: true },
};

/**
 * Во сколько раз крупнее элита. Единственное, чем ранг влияет на хитбокс:
 * размер остаётся свойством поведения, а не свободным числом в контенте
 * (docs/26-stage2-plan.md, WP4.4).
 */
export const ELITE_RADIUS_MUL = 1.7;

/**
 * Самый крупный хитбокс — на него расширяется запрос снаряда к сетке. Считаем
 * по элите: если взять обычный радиус, снаряды начнут пролетать сквозь
 * элиту — запрос к сетке вернёт её не во всех клетках, где она есть.
 */
export const MAX_PATTERN_RADIUS =
  Math.max(...Object.values(PATTERN_TRAITS).map((traits) => traits.radius)) * ELITE_RADIUS_MUL;

/**
 * Параметры паттерна, разложенные в плоский объект с полным набором полей.
 * Один и тот же вид объекта у всех типов — горячий цикл читает поля без
 * ветвлений и без проверок на `undefined`.
 */
export interface ResolvedPatternParams {
  steeringPerSec: number;
  preferredDistance: number;
  shotIntervalSec: number;
  projectileSpeed: number;
  triggerDistance: number;
  telegraphSec: number;
  dashSpeed: number;
  dashDurationSec: number;
  recoverSec: number;
  orbitRadius: number;
  shrinkPerSec: number;
  minRadius: number;
  fuseSec: number;
  blastRadius: number;
  leadSec: number;
  runSec: number;
  /** индекс типа, на который распадается делящийся; -1 — не распадается */
  childTypeIndex: number;
  childCount: number;
}

type NumericParam = Exclude<keyof ResolvedPatternParams, "childTypeIndex">;

const NEUTRAL_PARAMS: ResolvedPatternParams = {
  steeringPerSec: 0,
  preferredDistance: 0,
  shotIntervalSec: 0,
  projectileSpeed: 0,
  triggerDistance: 0,
  telegraphSec: 0,
  dashSpeed: 0,
  dashDurationSec: 0,
  recoverSec: 0,
  orbitRadius: 0,
  shrinkPerSec: 0,
  minRadius: 0,
  fuseSec: 0,
  blastRadius: 0,
  leadSec: 0,
  runSec: 0,
  childTypeIndex: -1,
  childCount: 0,
};

/**
 * Умолчания живут в движке, а не в контенте: врагу на готовом паттерне
 * достаточно hp, скорости и урона, а крутить параметры геймдизайнер начинает
 * тогда, когда умолчание не устроило.
 */
export const PATTERN_DEFAULTS: Record<EnemyPattern, Partial<Record<NumericParam, number>>> = {
  swarm: {},
  chase: { steeringPerSec: 3.2 },
  kite_and_shoot: { preferredDistance: 220, shotIntervalSec: 2.2, projectileSpeed: 260 },
  dash: {
    triggerDistance: 160,
    telegraphSec: 0.6,
    dashSpeed: 420,
    dashDurationSec: 0.35,
    recoverSec: 0.8,
  },
  orbit: { orbitRadius: 180, shrinkPerSec: 18, minRadius: 0 },
  exploder: { triggerDistance: 40, fuseSec: 0.9, blastRadius: 90 },
  splitter: { steeringPerSec: 3.2, childCount: 3 },
  rush: { leadSec: 0.55, runSec: 2.6 },
};

/** Параметры, которые геймдизайнер вправе задать каждому паттерну. */
const ALLOWED_PARAMS: Record<EnemyPattern, readonly string[]> = {
  swarm: [],
  chase: ["steeringPerSec"],
  kite_and_shoot: ["preferredDistance", "shotIntervalSec", "projectileSpeed"],
  dash: ["triggerDistance", "telegraphSec", "dashSpeed", "dashDurationSec", "recoverSec"],
  orbit: ["orbitRadius", "shrinkPerSec", "minRadius"],
  exploder: ["triggerDistance", "fuseSec", "blastRadius"],
  splitter: ["childEnemy", "childCount"],
  rush: ["leadSec", "runSec"],
};

/** Расстояния и скорости пересчитываются в пиксели устройства, время — нет. */
const SCALED_PARAMS: readonly NumericParam[] = [
  "preferredDistance",
  "projectileSpeed",
  "triggerDistance",
  "dashSpeed",
  "orbitRadius",
  "shrinkPerSec",
  "minRadius",
  "blastRadius",
];

/** Параметры, которые могут быть нулём; остальные строго положительны. */
const ZERO_ALLOWED: ReadonlySet<string> = new Set(["minRadius"]);

const MAX_CHILD_COUNT = 8;

/** Тип врага, разложенный из контента в плоский вид для горячего цикла. */
export interface EnemyType {
  id: string;
  hp: number;
  speed: number;
  damage: number;
  /** опыт за убийство — ценность кристалла на месте смерти */
  xp: number;
  /** стоимость в бюджете угрозы отрезка таймлайна */
  threat: number;
  /** усиленная версия паттерна: крупнее, светлее, приходит только событием */
  elite: boolean;
  pattern: EnemyPattern;
  radius: number;
  contactDamage: boolean;
  params: ResolvedPatternParams;
}

/**
 * Стоимость угрозы, когда её не задали в контенте. Грубая оценка того, во что
 * враг обходится игроку: здоровье надо прострелить, урон — пережить, скорость
 * решает, успеет ли он вообще добежать. Осмысленные числа ставятся руками —
 * формула не знает, что рой обязан приходить десятками (см. content/enemies.ts).
 */
export function defaultThreat(def: EnemyDef): number {
  return Math.max(1, def.hp / 12 + def.damage / 4 + def.speed / 60);
}

/**
 * Проблемы контента врагов человеческим языком. Один и тот же проверяющий
 * код работает в тесте контента — геймдизайнер узнаёт об ошибке из CI — и при
 * создании мира: невалидный контент не должен молча превращаться в нули.
 */
export function findEnemyContentProblems(defs: readonly EnemyDef[]): string[] {
  const problems: string[] = [];
  const byId = new Map<string, EnemyDef>();

  for (const def of defs) {
    if (byId.has(def.id)) problems.push(`враг ${def.id}: id повторяется`);
    byId.set(def.id, def);
  }

  for (const def of defs) {
    problems.push(...findBaseProblems(def));
    if (PATTERN_TRAITS[def.pattern] === undefined) {
      problems.push(`враг ${def.id}: паттерн ${String(def.pattern)} не реализован`);
      continue;
    }
    problems.push(...findParamProblems(def, byId));
  }
  return problems;
}

function findBaseProblems(def: EnemyDef): string[] {
  const problems: string[] = [];
  if (!(def.hp > 0)) problems.push(`враг ${def.id}: hp должен быть больше нуля`);
  if (!(def.speed > 0)) problems.push(`враг ${def.id}: speed должен быть больше нуля`);
  if (!(def.damage >= 0)) problems.push(`враг ${def.id}: damage не может быть отрицательным`);
  if (!(def.xp >= 0)) problems.push(`враг ${def.id}: xp не может быть отрицательным`);
  if (def.threat !== undefined && !(def.threat > 0)) {
    problems.push(`враг ${def.id}: threat должен быть больше нуля`);
  }
  return problems;
}

function findParamProblems(def: EnemyDef, byId: ReadonlyMap<string, EnemyDef>): string[] {
  const problems: string[] = [];
  const params: Readonly<Record<string, unknown>> = def.params ?? {};
  const allowed = ALLOWED_PARAMS[def.pattern];

  for (const [key, value] of Object.entries(params)) {
    if (!allowed.includes(key)) {
      problems.push(`враг ${def.id}: параметр ${key} не относится к паттерну ${def.pattern}`);
      continue;
    }
    if (key === "childEnemy") continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`враг ${def.id}: ${key} должен быть числом`);
    } else if (ZERO_ALLOWED.has(key) ? value < 0 : value <= 0) {
      problems.push(`враг ${def.id}: ${key} вне допустимых границ`);
    }
  }

  if (def.pattern === "orbit") problems.push(...findOrbitProblems(def.id, params));
  if (def.pattern === "splitter") problems.push(...findSplitterProblems(def.id, params, byId));
  return problems;
}

/*
 * Проверки ниже читают параметры как непроверенные данные, а не доверяют
 * типу: контент приедет из админки как JSON (docs/19-content-admin.md), и
 * валидатор обязан сообщить об ошибке, а не упасть на отсутствующем поле.
 */

function findOrbitProblems(id: string, params: Readonly<Record<string, unknown>>): string[] {
  const defaults = PATTERN_DEFAULTS.orbit;
  const orbitRadius = numberOr(params["orbitRadius"], defaults.orbitRadius ?? 0);
  const minRadius = numberOr(params["minRadius"], defaults.minRadius ?? 0);
  return minRadius < orbitRadius ? [] : [`враг ${id}: minRadius должен быть меньше orbitRadius`];
}

function findSplitterProblems(
  id: string,
  params: Readonly<Record<string, unknown>>,
  byId: ReadonlyMap<string, EnemyDef>,
): string[] {
  const problems: string[] = [];
  const childId = params["childEnemy"];
  const child = typeof childId === "string" ? byId.get(childId) : undefined;

  if (typeof childId !== "string") {
    problems.push(`враг ${id}: делящемуся врагу нужен childEnemy`);
  } else if (child === undefined) {
    problems.push(`враг ${id}: childEnemy ${childId} не найден`);
  } else if (child.pattern === "splitter") {
    // Делящийся из делящихся — геометрический рост популяции от одного
    // выстрела: пул кончается мгновенно, а экран заполняется за секунду.
    problems.push(`враг ${id}: childEnemy не может быть делящимся`);
  }

  const count = params["childCount"];
  if (count !== undefined && (!Number.isInteger(count) || Number(count) > MAX_CHILD_COUNT)) {
    problems.push(`враг ${id}: childCount — целое от 1 до ${MAX_CHILD_COUNT}`);
  }
  return problems;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/**
 * Разложить контент в типы для симуляции. Бросает на невалидном контенте:
 * ошибка при старте дешевле неверного поведения в забеге
 * (docs/15-engineering-standards.md §1, принцип 3).
 */
export function resolveEnemyTypes(defs: readonly EnemyDef[], unitScale: number): EnemyType[] {
  const problems = findEnemyContentProblems(defs);
  if (problems.length > 0) {
    throw new Error(`Некорректный контент врагов:\n${problems.join("\n")}`);
  }

  const indexById = new Map(defs.map((def, index) => [def.id, index]));
  return defs.map((def) => {
    const traits = PATTERN_TRAITS[def.pattern];
    return {
      id: def.id,
      hp: def.hp,
      speed: def.speed * unitScale,
      damage: def.damage,
      xp: def.xp,
      threat: def.threat ?? defaultThreat(def),
      elite: def.elite === true,
      pattern: def.pattern,
      radius: traits.radius * (def.elite === true ? ELITE_RADIUS_MUL : 1) * unitScale,
      contactDamage: traits.contactDamage,
      params: resolveParams(def, indexById, unitScale),
    };
  });
}

function resolveParams(
  def: EnemyDef,
  indexById: ReadonlyMap<string, number>,
  unitScale: number,
): ResolvedPatternParams {
  const resolved: ResolvedPatternParams = { ...NEUTRAL_PARAMS, ...PATTERN_DEFAULTS[def.pattern] };
  const params: Readonly<Record<string, unknown>> = def.params ?? {};

  for (const [key, value] of Object.entries(params)) {
    if (key === "childEnemy" && typeof value === "string") {
      resolved.childTypeIndex = indexById.get(value) ?? -1;
    } else if (typeof value === "number" && isNumericParam(key)) {
      resolved[key] = value;
    }
  }

  for (const key of SCALED_PARAMS) resolved[key] *= unitScale;
  return resolved;
}

function isNumericParam(key: string): key is NumericParam {
  return key in NEUTRAL_PARAMS && key !== "childTypeIndex";
}
