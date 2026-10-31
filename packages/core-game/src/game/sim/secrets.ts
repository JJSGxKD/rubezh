import { SECRET_KINDS, type BlessingDef, type SecretKind, type SecretsDef } from "@bh/shared-types";
import { combineModifiers } from "../progression/boosts";
import { refreshPlayerStats } from "../progression/levels";
import { isElite } from "../patterns/enemy-types";
import { openChest } from "./chests";
import { createDirection, randomRingOffset, ringDirection } from "./directions";
import type { Rng } from "./rng";
import { radiusOf } from "./secrets-rules";
import { vectorLength } from "./vector";
import {
  clampToBounds,
  spawnEnemy,
  TICK_HZ,
  TICK_SEC,
  type BlessingOffered,
  type SecretFound,
  type SecretSite,
  type SecretUsed,
  type World,
} from "./world";

/**
 * Тайники рубежа (docs/35-stage4-plan.md, Р153; design/art/meta-v2.md §5):
 * места на бесконечной карте, ради которых стоит идти.
 *
 * - **капище** — постоять в круге, выбрать одно из благословений на забег;
 * - **клад** — постоять в круге, получить сундук;
 * - **камень-указатель** — коснуться, и все тайники видны на радаре;
 * - **древо-оберег** — рядом лечит и раз в минуту даёт щит, но не отпускает: оно не исчезает;
 * - **разлом Нави** — вошёл, и выходит волна элит; выдержал — большой сундук;
 * - **огонёк** — появляется у игрока и летит к ближайшему неоткрытому тайнику.
 *
 * Раскладка бросается один раз при создании мира: по кольцам от старта, из
 * собственного потока случайности `world.secrets.rng`. Общий `world.rng`
 * здесь не трогается ни разу — иначе любой бросок тайника сдвинул бы все
 * golden-прогоны и все предложения уровней. Только целочисленная арифметика и
 * `Math.sqrt`: приближённая математика расходится между JS-движками.
 */

export { createSecretState } from "./secrets-layout";
export { findSecretsProblems } from "./secrets-rules";

const scratch = createDirection();

function holdTicksOf(holdSec: number): number {
  return Math.round(holdSec * TICK_HZ);
}

// --- Шаг ----------------------------------------------------------------------

/**
 * Один шаг тайников: найти, посчитать стояние, сработать, подвинуть огонёк.
 * Вызывается из шага мира после движения игрока, до подготовки выбора уровня:
 * награда клада может набрать уровень, и выбор встанет в тот же шаг.
 */
export function updateSecrets(world: World): void {
  const sites = world.secrets.sites;
  if (sites.length === 0) return;

  // Шаг заканчивается тиком, который ещё не записан в статистику: «на 90-й
  // секунде» значит на 5400-м шаге, а не на следующем.
  const tick = world.stats.tick + 1;
  const elapsedSec = tick * TICK_SEC;

  // Сначала места на земле, потом огоньки: огонёк должен видеть, что игрок
  // нашёл тайник в этом же тике, и не зависеть от порядка раскладки.
  if (world.player.alive) {
    for (let i = 0; i < sites.length; i++) {
      if (sites[i].kind !== "wisp") updateSite(world, i, elapsedSec);
    }
  }
  for (let i = 0; i < sites.length; i++) {
    if (sites[i].kind === "wisp") updateWisp(world, i, tick, elapsedSec);
  }
}

function inCircle(world: World, site: SecretSite, radiusUnits: number): boolean {
  const radius = radiusUnits * world.config.unitScale;
  const dx = world.player.x - site.x;
  const dy = world.player.y - site.y;
  return dx * dx + dy * dy <= radius * radius;
}

function updateSite(world: World, index: number, elapsedSec: number): void {
  const site = world.secrets.sites[index];
  if (site.used) return;

  const rules = world.secretRules;
  // Разлом, из которого вышла волна, следит за ней и вне круга: игрок уходит драться.
  if (site.kind === "rift" && site.opened) {
    updateRiftWave(world, index, elapsedSec);
    return;
  }
  if (!inCircle(world, site, radiusOf(rules, site.kind))) {
    // Вышел из круга — стояние начинается заново. Урон его не сбрасывает: риск
    // в том, что стоишь в толпе.
    site.holdTicks = 0;
    return;
  }
  if (!site.found) markFound(world, index, elapsedSec);

  switch (site.kind) {
    case "stone":
      touchStone(world, index, elapsedSec);
      return;
    case "shrine":
      site.holdTicks++;
      if (site.holdTicks >= holdTicksOf(rules.shrine.holdSec)) openShrine(world, index, elapsedSec);
      return;
    case "hoard":
      site.holdTicks++;
      if (site.holdTicks >= holdTicksOf(rules.hoard.holdSec)) digHoard(world, index, elapsedSec);
      return;
    case "tree":
      site.holdTicks++;
      tendTree(world, site);
      return;
    case "rift":
      openRift(world, index);
      return;
    case "wisp":
      return;
  }
}

function markFound(world: World, index: number, elapsedSec: number): void {
  const site = world.secrets.sites[index];
  site.found = true;
  site.visible = true;
  world.secrets.foundLog.push({ index, kind: site.kind, elapsedSec });
}

function recordUsed(world: World, index: number, outcome: string, elapsedSec: number): void {
  const site = world.secrets.sites[index];
  site.used = true;
  site.holdTicks = 0;
  world.secrets.usedLog.push({ index, kind: site.kind, outcome, elapsedSec });
}

/** Камень отмечает на радаре все тайники, которые уже есть на карте. */
function touchStone(world: World, index: number, elapsedSec: number): void {
  for (const site of world.secrets.sites) {
    if (site.active) site.visible = true;
  }
  recordUsed(world, index, "touched", elapsedSec);
}

/** Клад — сундук через сундуки забега: награды, их журнал и счётчики те же. */
function digHoard(world: World, index: number, elapsedSec: number): void {
  recordUsed(world, index, "opened", elapsedSec);
  openChest(world, world.secretRules.hoard.chestSize);
}

// --- Древо-оберег ---------------------------------------------------------------

/**
 * Игрок в круге древа: лечение долей максимума здоровья за тик и щит раз в период. Отсчёт щита идёт по
 * непрерывному стоянию — ушёл, и накопленное сгорает. Щит не копится: непотраченный остаётся одним.
 */
function tendTree(world: World, site: SecretSite): void {
  const rules = world.secretRules.tree;
  const player = world.player;
  if (player.hp < player.maxHp) {
    player.hp = Math.min(player.maxHp, player.hp + player.maxHp * rules.healPerSec * TICK_SEC);
  }
  const period = holdTicksOf(rules.shieldEverySec);
  if (site.holdTicks % period === 0 && player.shieldHits < 1) player.shieldHits = 1;
}

// --- Разлом Нави ----------------------------------------------------------------

/**
 * Вход в круг разлома: выпустить волну. Состав и места — из потока тайников, как и вся раскладка, а не
 * из `world.rng`; потолок живых волна не спрашивает — спавн упирается только в ёмкость пула. Нет элит в
 * контенте или нет места в пуле — волны нет, и разлом закрывается без награды.
 */
function openRift(world: World, index: number): void {
  const site = world.secrets.sites[index];
  const rules = world.secretRules.rift;
  site.opened = true;

  const pool: number[] = [];
  world.enemyTypes.forEach((type, typeIndex) => {
    if (isElite(type)) pool.push(typeIndex);
  });
  if (pool.length === 0) {
    site.used = true;
    return;
  }

  const rng = world.secrets.rng;
  const offset = randomRingOffset(rng);
  const radius = rules.ringRadius * world.config.unitScale;
  const bounds = world.config.bounds;
  for (let k = 0; k < rules.elites; k++) {
    const type = pool[rng.nextInt(0, pool.length)];
    ringDirection(offset, k, rules.elites, scratch);
    const slot = spawnEnemy(world, type, clampToBounds(site.x + scratch.x * radius, bounds.halfWidth), clampToBounds(site.y + scratch.y * radius, bounds.halfHeight));
    if (slot >= 0) site.wave.push({ slot, type });
  }
  if (site.wave.length === 0) site.used = true;
}

/**
 * Волна идёт: все убиты — сундук у разлома и разлом закрывается; игрок ушёл дальше кольца, не добив, —
 * закрывается без награды. Слот считается своим, пока в нём живёт элита того же типа: убитая вышла из
 * пула, а переиспользованный слот чужого типа в волну не входит.
 */
function updateRiftWave(world: World, index: number, elapsedSec: number): void {
  const site = world.secrets.sites[index];
  const rules = world.secretRules.rift;
  const enemies = world.enemies;
  site.wave = site.wave.filter((entry) => enemies.alive[entry.slot] === 1 && enemies.type[entry.slot] === entry.type);

  if (site.wave.length === 0) {
    recordUsed(world, index, "cleared", elapsedSec);
    openChest(world, rules.chestSize);
    return;
  }
  const dx = world.player.x - site.x;
  const dy = world.player.y - site.y;
  const away = rules.ringRadius * world.config.unitScale;
  if (dx * dx + dy * dy > away * away) {
    site.wave = [];
    recordUsed(world, index, "left", elapsedSec);
  }
}

// --- Капище и благословения -----------------------------------------------------

/**
 * Капище отстояно: выбрать предложение. Набор бросается из потока тайников
 * всегда — выберет игрок или возьмётся первое, поток тратится одинаково, и
 * раскладка забега не зависит от того, остановлен он на выборе или нет.
 */
function openShrine(world: World, index: number, elapsedSec: number): void {
  const secrets = world.secrets;
  const site = secrets.sites[index];
  const rules = world.secretRules;
  site.used = true;
  site.holdTicks = 0;

  const options = drawBlessingIds(world.secrets.rng, rules);
  secrets.blessingLog.push({ index, options: options.map((id) => blessingById(rules, id)), elapsedSec });

  if (secrets.manualBlessing) {
    secrets.offer = { siteIndex: index, options };
    return;
  }
  applyBlessing(world, index, options[0], elapsedSec);
}

/** Несколько разных благословений: частичное перемешивание, а не повторные броски. */
function drawBlessingIds(rng: Rng, rules: SecretsDef): string[] {
  const pool = rules.blessings.map((blessing) => blessing.id);
  const count = Math.min(rules.shrine.offers, pool.length);
  for (let k = 0; k < count; k++) {
    const pick = k + rng.nextInt(0, pool.length - k);
    const picked = pool[pick];
    pool[pick] = pool[k];
    pool[k] = picked;
  }
  return pool.slice(0, count);
}

function blessingById(rules: SecretsDef, id: string): BlessingDef {
  const blessing = rules.blessings.find((candidate) => candidate.id === id);
  if (blessing === undefined) throw new Error(`Нет благословения ${id}`);
  return blessing;
}

/** Ждёт ли мир выбора благословения — как `isAwaitingChoice` для уровня. */
export function isAwaitingBlessing(world: World): boolean {
  return world.secrets.offer !== null;
}

/**
 * Ответ игрока на капище. Идентификатор приходит снаружи — из окна выбора или
 * из лога ввода, — поэтому предложенным он обязан быть: иначе `false`, и мир
 * остаётся на выборе.
 */
export function chooseBlessing(world: World, id: string): boolean {
  const secrets = world.secrets;
  const offer = secrets.offer;
  if (offer === null || !offer.options.includes(id)) return false;

  secrets.offer = null;
  applyBlessing(world, offer.siteIndex, id, world.stats.elapsedSec);
  return true;
}

/**
 * Прибавка благословения идёт в те же модификаторы, что снаряжение и бусты, и
 * упирается в те же пределы движка, а потом характеристики пересчитываются
 * целиком — так прибавка не пропадает на следующем уровне.
 */
function applyBlessing(world: World, siteIndex: number, id: string, elapsedSec: number): void {
  const blessing = blessingById(world.secretRules, id);
  world.secrets.blessings.push(id);
  world.loadoutModifiers = combineModifiers(world.loadoutModifiers, blessing.modifiers);
  refreshPlayerStats(world);
  recordUsed(world, siteIndex, id, elapsedSec);
}

/**
 * Применить взятые благословения заново к миру, только что собранному из
 * того же набора: так возвращается прибавка при восстановлении из снимка.
 */
export function restoreBlessings(world: World, ids: readonly string[]): void {
  world.secrets.blessings = [];
  for (const id of ids) {
    // Незнакомый id — снимок чужого контента или битый: прибавки нет, забег идёт.
    const blessing = world.secretRules.blessings.find((candidate) => candidate.id === id);
    if (blessing === undefined) continue;
    world.secrets.blessings.push(id);
    world.loadoutModifiers = combineModifiers(world.loadoutModifiers, blessing.modifiers);
  }
  refreshPlayerStats(world);
}

// --- Огонёк -------------------------------------------------------------------

function updateWisp(world: World, index: number, tick: number, elapsedSec: number): void {
  const site = world.secrets.sites[index];
  const rules = world.secretRules;

  if (!site.active) {
    if (tick < holdTicksOf(rules.wisp.appearSec) || !world.player.alive) return;
    // Появляется там, где стоит игрок: подсказка приходит к нему, а не лежит на карте.
    site.active = true;
    site.x = world.player.x;
    site.y = world.player.y;
    markFound(world, index, elapsedSec);
    return;
  }

  const target = nearestUnfound(world, site);
  if (target === null) return;

  // Ждёт на краю круга, а не на самом тайнике: знак тайника остаётся виден.
  const stopAt = radiusOf(rules, target.kind) * world.config.unitScale;
  const dx = target.x - site.x;
  const dy = target.y - site.y;
  const distance = vectorLength(dx, dy);
  const remaining = distance - stopAt;
  if (remaining <= 0) return;

  scratch.x = dx / distance;
  scratch.y = dy / distance;
  const step = rules.wisp.speed * world.config.unitScale * TICK_SEC;
  const travelled = remaining <= step ? remaining : step;
  site.x += scratch.x * travelled;
  site.y += scratch.y * travelled;
}

/** Ближайший к огоньку тайник на земле, в круг которого игрок ещё не входил. */
function nearestUnfound(world: World, wisp: SecretSite): SecretSite | null {
  let best: SecretSite | null = null;
  let bestSq = Infinity;
  for (const site of world.secrets.sites) {
    if (site.kind === "wisp" || !site.active || site.found) continue;
    const dx = site.x - wisp.x;
    const dy = site.y - wisp.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestSq) {
      bestSq = distanceSq;
      best = site;
    }
  }
  return best;
}

// --- Итог и события для сцены ---------------------------------------------------

/** Найденные виды без повторов, в каноническом порядке `SECRET_KINDS`. */
export function secretKindsFound(world: World): SecretKind[] {
  return SECRET_KINDS.filter((kind) => world.secrets.sites.some((site) => site.kind === kind && site.found));
}

/** Использованные виды без повторов, в каноническом порядке. */
export function secretKindsUsed(world: World): SecretKind[] {
  return SECRET_KINDS.filter((kind) => world.secrets.sites.some((site) => site.kind === kind && site.used));
}

/** Сколько записей сцена уже забрала. */
export interface SecretCursor {
  found: number;
  used: number;
  blessings: number;
}

export interface SecretEvents {
  found: SecretFound[];
  used: SecretUsed[];
  blessings: BlessingOffered[];
  cursor: SecretCursor;
}

/** Новые записи после курсора и сдвинутый курсор. Мир не меняется. */
export function takeSecretEvents(world: World, cursor: SecretCursor): SecretEvents {
  const { foundLog, usedLog, blessingLog } = world.secrets;
  return {
    found: foundLog.slice(cursor.found),
    used: usedLog.slice(cursor.used),
    blessings: blessingLog.slice(cursor.blessings),
    cursor: { found: foundLog.length, used: usedLog.length, blessings: blessingLog.length },
  };
}
