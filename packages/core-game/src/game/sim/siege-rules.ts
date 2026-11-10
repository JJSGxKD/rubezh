import type { EnemyDef, SiegeDef } from "@bh/shared-types";
import { CORDON_MAX_COUNT, findRingProblems } from "./timeline-content";

/**
 * Правила осады как данные: проверка `content/siege.ts` и размер осады по уровню. Мира и случайности
 * здесь нет — этим файлом пользуются и шаг осады, и проверка контента, и тесты.
 */

/** Потолок элит одной осады: все они выходят разом мимо потолка живых, и пул слотов не бесконечен. */
export const SIEGE_MAX_ELITES = 24;

const MAX_LEVEL_FLOOR = 1;
/** Потолок `maxLevel` в данных; снимок забега не принимает уровень выше него. */
export const SIEGE_LEVEL_CEILING = 10;
const GROWTH_MIN = 1;
const GROWTH_MAX = 2;

/**
 * Сколько врагов в осаде уровня `level`: база, умноженная на `growth` столько раз, каков уровень.
 * Степень — умножением в цикле: `Math.pow` приближённый и расходится между JS-движками.
 */
export function siegeCount(base: number, growth: number, level: number): number {
  let value = base;
  for (let step = 0; step < level; step++) value *= growth;
  return Math.round(value);
}

/**
 * Ошибки в числах осады — с именем поля, как у остального контента. `enemies` нужен, чтобы сверить
 * стража: без списка проверяются только числа, и ссылка на врага остаётся на совести вызывающего.
 */
export function findSiegeProblems(def: SiegeDef, enemies?: readonly EnemyDef[]): string[] {
  const problems: string[] = [];
  const finite = (value: number): boolean => Number.isFinite(value);

  if (!(finite(def.fromSec) && def.fromSec >= 0)) problems.push(`siege.fromSec — число не меньше 0, сейчас ${def.fromSec}`);
  if (!(finite(def.holdSec) && def.holdSec > 0)) problems.push(`siege.holdSec — больше 0, сейчас ${def.holdSec}`);
  if (!(finite(def.warnSec) && def.warnSec > 0 && def.warnSec < def.holdSec)) {
    problems.push(`siege.warnSec — больше 0 и меньше holdSec (${def.holdSec}), сейчас ${def.warnSec}`);
  }
  if (!(finite(def.cooldownSec) && def.cooldownSec >= 0)) problems.push(`siege.cooldownSec — число не меньше 0, сейчас ${def.cooldownSec}`);
  if (!(finite(def.calmSec) && def.calmSec > 0)) problems.push(`siege.calmSec — больше 0, сейчас ${def.calmSec}`);

  // Игрок в круге обязан быть внутри строя, а не за спинами стражей: круг уже кольца.
  if (!(finite(def.radius) && def.radius > 0 && def.radius < def.cordon.ring.radius)) {
    problems.push(`siege.radius — больше 0 и меньше радиуса строя cordon.ring.radius (${def.cordon.ring.radius}), сейчас ${def.radius}`);
  }
  if (!(finite(def.growth) && def.growth >= GROWTH_MIN && def.growth <= GROWTH_MAX)) {
    problems.push(`siege.growth — от ${GROWTH_MIN} до ${GROWTH_MAX}, сейчас ${def.growth}`);
  }
  const levelOk = Number.isInteger(def.maxLevel) && def.maxLevel >= MAX_LEVEL_FLOOR && def.maxLevel <= SIEGE_LEVEL_CEILING;
  if (!levelOk) problems.push(`siege.maxLevel — целое от ${MAX_LEVEL_FLOOR} до ${SIEGE_LEVEL_CEILING}, сейчас ${def.maxLevel}`);

  const guard = enemies?.find((enemy) => enemy.id === def.cordon.enemy);
  if (enemies !== undefined) {
    if (guard === undefined) problems.push(`siege.cordon.enemy — нет врага ${def.cordon.enemy} в контенте`);
    else if (guard.pattern !== "cordon") problems.push(`siege.cordon.enemy — ${def.cordon.enemy} не паттерна cordon, а ${guard.pattern}`);
  }
  const byId: ReadonlyMap<string, EnemyDef> = new Map((enemies ?? []).map((enemy) => [enemy.id, enemy]));
  problems.push(...findRingProblems(def.cordon.ring, "siege.cordon", guard, byId));

  if (!Number.isInteger(def.cordon.count) || def.cordon.count < 1 || def.cordon.count > CORDON_MAX_COUNT) {
    problems.push(`siege.cordon.count — целое от 1 до ${CORDON_MAX_COUNT}, сейчас ${def.cordon.count}`);
  } else if (levelOk && finite(def.growth)) {
    const top = siegeCount(def.cordon.count, def.growth, def.maxLevel);
    if (top > CORDON_MAX_COUNT) {
      problems.push(`siege.cordon.count — на уровне maxLevel (${def.maxLevel}) строй вырастает до ${top}, а потолок кольца ${CORDON_MAX_COUNT}`);
    }
  }
  if (!Number.isInteger(def.eliteCount) || def.eliteCount < 0) {
    problems.push(`siege.eliteCount — целое не меньше 0, сейчас ${def.eliteCount}`);
  } else if (levelOk && finite(def.growth)) {
    const top = siegeCount(def.eliteCount, def.growth, def.maxLevel);
    if (top > SIEGE_MAX_ELITES) {
      problems.push(`siege.eliteCount — на уровне maxLevel (${def.maxLevel}) элит ${top}, а потолок осады ${SIEGE_MAX_ELITES}`);
    }
  }
  return problems;
}
