import { ELEMENT_COLD, ELEMENT_FIRE, ELEMENT_LIGHTNING, ELEMENT_PHYSICAL, ELEMENT_POISON } from "./element-ids";
import type { World } from "./world";

export { ELEMENT_COLD, ELEMENT_FIRE, ELEMENT_LIGHTNING, ELEMENT_PHYSICAL, ELEMENT_POISON, MAX_RESIST, MIN_RESIST, elementIndex } from "./element-ids";

/**
 * Стихии и состояния (docs/35-stage4-plan.md, §3.3, Р24, WP6).
 *
 * | Стихия | Состояние | Что делает |
 * |---|---|---|
 * | огонь | горение | урон по времени; не складывается — обновляет длительность и берёт больший урон |
 * | холод | охлаждение → заморозка | замедляет; накопив порог — замораживает: враг не ходит и не бьёт |
 * | молния | шок | шокированный получает больше урона от всего |
 * | яд | отравление | складывается слоями, урон растёт с числом слоёв |
 *
 * **Детерминизм.** Состояния тикают вместе с миром, шанс — через генератор
 * забега, и только когда он меньше единицы и больше нуля: оружие без
 * стихии не трогает генератор вовсе, и забеги прежнего контента не
 * расходятся с эталонами. Приближённых функций здесь нет (`sim-purity`).
 *
 * **Числа — рабочие** (Р31): стоят до контента со стихиями (О7).
 */

/** Горение: доля урона попадания в секунду и сколько горит. */
export const BURN_DPS_SHARE = 0.3;
export const BURN_SEC = 3;
/** Охлаждение: насколько медленнее и сколько держится. */
export const CHILL_SLOW = 0.35;
export const CHILL_SEC = 2;
/** Столько охлаждений подряд — заморозка; держится недолго, иначе холод решал бы бой сам. */
export const FREEZE_BUILD = 4;
export const FREEZE_SEC = 1;
/** Шок: насколько больше урона получает шокированный. */
export const SHOCK_BONUS = 0.25;
export const SHOCK_SEC = 4;
/**
 * Перескок молнии: удар молнией по уже шокированному врагу перескакивает на
 * ближайших — вот зачем шок, кроме лишнего урона. Бьёт долей удара и не
 * перескакивает дальше: цепь без конца выкосила бы толпу одним ударом.
 */
export const CHAIN_TARGETS = 2;
export const CHAIN_RADIUS = 70;
export const CHAIN_SHARE = 0.4;

/** Отравление: доля урона попадания в секунду за слой, потолок слоёв и длительность. */
export const POISON_DPS_SHARE = 0.08;
export const POISON_MAX_STACKS = 10;
export const POISON_SEC = 4;

/**
 * Множитель урона стихией по врагу: сопротивление типа, шок и усиление
 * стихии снаряжением игрока. Урон по времени и перескок проходят через тот
 * же множитель — сборка «под огонь» усиливает и горение.
 */
export function damageMultiplier(world: World, index: number, element: number): number {
  const type = world.enemyTypes[world.enemies.type[index]];
  const resist = (type.resistMul[element] ?? 1) * elementDamageMul(world, element);
  return world.enemies.shockTimer[index] > 0 ? resist * (1 + SHOCK_BONUS) : resist;
}

function elementDamageMul(world: World, element: number): number {
  const stats = world.playerStats;
  switch (element) {
    case ELEMENT_FIRE:
      return stats.fireDamageMul;
    case ELEMENT_COLD:
      return stats.coldDamageMul;
    case ELEMENT_LIGHTNING:
      return stats.lightningDamageMul;
    case ELEMENT_POISON:
      return stats.poisonDamageMul;
    default:
      return 1;
  }
}

/**
 * Попытка наложить состояние стихии после попадания. `dealt` — урон этого
 * попадания уже с сопротивлением: горение и яд считаются от него, и стойкий
 * к огню враг горит слабее.
 */
export function tryApplyStatus(world: World, index: number, element: number, baseChance: number, dealt: number, weaponSlot: number): void {
  if (element === ELEMENT_PHYSICAL || baseChance <= 0) return;
  // Шанс от снаряжения растёт до единицы, а не за неё: дальше генератор не
  // нужен — и не трогается.
  const chance = Math.min(1, baseChance * world.playerStats.statusChanceMul);
  if (chance < 1 && world.rng.nextFloat() >= chance) return;
  const enemies = world.enemies;
  switch (element) {
    case ELEMENT_FIRE: {
      enemies.burnTimer[index] = BURN_SEC;
      enemies.burnDps[index] = Math.max(enemies.burnDps[index], dealt * BURN_DPS_SHARE);
      enemies.burnSlot[index] = weaponSlot;
      return;
    }
    case ELEMENT_COLD: {
      enemies.chillTimer[index] = CHILL_SEC;
      // Босса не заморозить: бой с ним — событие забега, и секундная
      // заморозка каждые четыре попадания превратила бы его в мишень.
      if (world.enemyTypes[enemies.type[index]].rank === "boss") return;
      enemies.chillBuild[index]++;
      if (enemies.chillBuild[index] >= FREEZE_BUILD) {
        enemies.chillBuild[index] = 0;
        enemies.frozenTimer[index] = FREEZE_SEC;
      }
      return;
    }
    case ELEMENT_LIGHTNING: {
      enemies.shockTimer[index] = SHOCK_SEC;
      return;
    }
    case ELEMENT_POISON: {
      enemies.poisonStacks[index] = Math.min(POISON_MAX_STACKS, enemies.poisonStacks[index] + 1);
      enemies.poisonTimer[index] = POISON_SEC;
      enemies.poisonDps[index] = Math.max(enemies.poisonDps[index], dealt * POISON_DPS_SHARE);
      enemies.poisonSlot[index] = weaponSlot;
      return;
    }
  }
}

/** Урон по времени за тик: горение и яд. Отдаётся вызывающему — наносит его `combat.ts`. */
export interface StatusTick {
  burn: number;
  poison: number;
}

/**
 * Тик состояний врага: таймеры убывают, урон по времени копится в `out`.
 * Результат — в переданный объект: функция зовётся на каждого врага каждый
 * тик, и новый объект на вызов — это сотни аллокаций в кадр.
 */
export function tickStatuses(world: World, index: number, dt: number, out: StatusTick): void {
  const enemies = world.enemies;
  out.burn = 0;
  out.poison = 0;

  if (enemies.burnTimer[index] > 0) {
    out.burn = enemies.burnDps[index] * Math.min(dt, enemies.burnTimer[index]);
    enemies.burnTimer[index] -= dt;
    if (enemies.burnTimer[index] <= 0) {
      enemies.burnTimer[index] = 0;
      enemies.burnDps[index] = 0;
    }
  }
  if (enemies.poisonTimer[index] > 0) {
    out.poison = enemies.poisonDps[index] * enemies.poisonStacks[index] * Math.min(dt, enemies.poisonTimer[index]);
    enemies.poisonTimer[index] -= dt;
    if (enemies.poisonTimer[index] <= 0) {
      enemies.poisonTimer[index] = 0;
      enemies.poisonStacks[index] = 0;
      enemies.poisonDps[index] = 0;
    }
  }
  if (enemies.chillTimer[index] > 0) {
    enemies.chillTimer[index] -= dt;
    // Охлаждение сошло — копилка к заморозке пустеет: заморозка — за серию
    // попаданий, а не за четыре попадания за весь забег.
    if (enemies.chillTimer[index] <= 0) {
      enemies.chillTimer[index] = 0;
      enemies.chillBuild[index] = 0;
    }
  }
  if (enemies.frozenTimer[index] > 0) enemies.frozenTimer[index] = Math.max(0, enemies.frozenTimer[index] - dt);
  if (enemies.shockTimer[index] > 0) enemies.shockTimer[index] = Math.max(0, enemies.shockTimer[index] - dt);
}

/** Во сколько раз медленнее враг: заморожен — стоит, охлаждён — медленнее. */
export function movementFactor(world: World, index: number): number {
  if (world.enemies.frozenTimer[index] > 0) return 0;
  return world.enemies.chillTimer[index] > 0 ? 1 - CHILL_SLOW : 1;
}

export function isFrozen(world: World, index: number): boolean {
  return world.enemies.frozenTimer[index] > 0;
}

/** Сбросить состояния слота: новый враг не наследует горение прежнего жильца. */
export function clearStatuses(world: World, index: number, noOwner: number): void {
  const enemies = world.enemies;
  enemies.burnTimer[index] = 0;
  enemies.burnDps[index] = 0;
  enemies.burnSlot[index] = noOwner;
  enemies.chillTimer[index] = 0;
  enemies.chillBuild[index] = 0;
  enemies.frozenTimer[index] = 0;
  enemies.shockTimer[index] = 0;
  enemies.poisonTimer[index] = 0;
  enemies.poisonStacks[index] = 0;
  enemies.poisonDps[index] = 0;
  enemies.poisonSlot[index] = noOwner;
}

/**
 * Куда перескакивает молния: до `CHAIN_TARGETS` ближайших живых врагов в
 * радиусе, кроме того, по кому ударили. Результат — индексы в `out`, число —
 * возвращается. Два ближайших — простым проходом без сортировки: в радиусе
 * их десятки, и сортировка на каждый удар молнии — лишняя работа.
 * Порядок обхода задаёт сетка, поэтому выбор детерминирован.
 */
export function chainTargets(world: World, index: number, out: Int32Array): number {
  const enemies = world.enemies;
  const radius = CHAIN_RADIUS * world.config.unitScale;
  const x = enemies.x[index];
  const y = enemies.y[index];
  const found = world.enemyGrid.queryInto(x, y, radius, world.chainBuffer);
  let first = -1;
  let second = -1;
  let firstDistance = Infinity;
  let secondDistance = Infinity;
  for (let k = 0; k < found; k++) {
    const other = world.chainBuffer[k];
    if (other === index || enemies.alive[other] === 0) continue;
    const dx = enemies.x[other] - x;
    const dy = enemies.y[other] - y;
    const distance = dx * dx + dy * dy;
    if (distance > radius * radius) continue;
    if (distance < firstDistance) {
      second = first;
      secondDistance = firstDistance;
      first = other;
      firstDistance = distance;
    } else if (distance < secondDistance) {
      second = other;
      secondDistance = distance;
    }
  }
  let count = 0;
  if (first >= 0 && CHAIN_TARGETS > 0) out[count++] = first;
  if (second >= 0 && CHAIN_TARGETS > 1) out[count++] = second;
  return count;
}
