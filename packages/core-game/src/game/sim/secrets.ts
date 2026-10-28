import { LOADOUT_STATS, SECRET_KINDS, type BlessingDef, type LoadoutStat, type SecretKind, type SecretsDef } from "@bh/shared-types";
import { combineModifiers } from "../progression/boosts";
import { drawWeighted, refreshPlayerStats } from "../progression/levels";
import { LOADOUT_BOUNDS } from "../progression/run-loadout";
import { openChest } from "./chests";
import { createDirection, randomDirection } from "./directions";
import type { WorldBounds } from "./map-types";
import type { Rng } from "./rng";
import { vectorLength } from "./vector";
import {
  clampToBounds,
  TICK_HZ,
  TICK_SEC,
  type BlessingOffered,
  type SecretFound,
  type SecretSite,
  type SecretState,
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
 * - **огонёк** — появляется у игрока и летит к ближайшему неоткрытому тайнику.
 *
 * Раскладка бросается один раз при создании мира: по кольцам от старта, из
 * собственного потока случайности `world.secrets.rng`. Общий `world.rng`
 * здесь не трогается ни разу — иначе любой бросок тайника сдвинул бы все
 * golden-прогоны и все предложения уровней. Только целочисленная арифметика и
 * `Math.sqrt`: приближённая математика расходится между JS-движками.
 */

// --- Контент ------------------------------------------------------------------

const ALLOWED_CHEST_SIZES: readonly number[] = [1, 3, 5];

export function findSecretsProblems(def: SecretsDef): string[] {
  const problems: string[] = [];
  const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

  let previousEnd = 0;
  def.rings.forEach((ring, i) => {
    const path = `secrets.rings[${i}]`;
    if (!positive(ring.minRadius) || ring.minRadius <= previousEnd) {
      problems.push(`${path}.minRadius — больше конца прошлого кольца (${previousEnd}), сейчас ${ring.minRadius}`);
    }
    if (!(Number.isFinite(ring.maxRadius) && ring.maxRadius > ring.minRadius)) {
      problems.push(`${path}.maxRadius — больше minRadius (${ring.minRadius}), сейчас ${ring.maxRadius}`);
    }
    previousEnd = Number.isFinite(ring.maxRadius) ? ring.maxRadius : previousEnd;

    if (!Number.isInteger(ring.count) || ring.count < 1) {
      problems.push(`${path}.count — целое не меньше 1, сейчас ${ring.count}`);
    }
    if (ring.kinds.length === 0) problems.push(`${path}.kinds — нужен хотя бы один вид`);
    ring.kinds.forEach((entry, k) => {
      if (!SECRET_KINDS.includes(entry.kind)) {
        problems.push(`${path}.kinds[${k}].kind — один из ${SECRET_KINDS.join(", ")}, сейчас ${String(entry.kind)}`);
      }
      if (!positive(entry.weight)) problems.push(`${path}.kinds[${k}].weight — больше 0, сейчас ${entry.weight}`);
    });
  });

  if (!(Number.isFinite(def.minGapUnits) && def.minGapUnits >= 0)) {
    problems.push(`secrets.minGapUnits — не меньше 0, сейчас ${def.minGapUnits}`);
  }

  for (const key of ["shrine", "hoard"] as const) {
    if (!positive(def[key].radius)) problems.push(`secrets.${key}.radius — больше 0, сейчас ${def[key].radius}`);
    if (!positive(def[key].holdSec)) problems.push(`secrets.${key}.holdSec — больше 0, сейчас ${def[key].holdSec}`);
  }
  if (!Number.isInteger(def.shrine.offers) || def.shrine.offers < 1 || def.shrine.offers > def.blessings.length) {
    problems.push(`secrets.shrine.offers — целое от 1 до числа благословений (${def.blessings.length}), сейчас ${def.shrine.offers}`);
  }
  if (!ALLOWED_CHEST_SIZES.includes(def.hoard.chestSize)) {
    problems.push(`secrets.hoard.chestSize — размер 1, 3 или 5, сейчас ${def.hoard.chestSize}`);
  }
  if (!positive(def.stone.radius)) problems.push(`secrets.stone.radius — больше 0, сейчас ${def.stone.radius}`);
  if (!(Number.isFinite(def.wisp.appearSec) && def.wisp.appearSec >= 0)) {
    problems.push(`secrets.wisp.appearSec — не меньше 0, сейчас ${def.wisp.appearSec}`);
  }
  if (!positive(def.wisp.speed)) problems.push(`secrets.wisp.speed — больше 0, сейчас ${def.wisp.speed}`);

  const seen = new Set<string>();
  def.blessings.forEach((blessing, i) => {
    const path = `secrets.blessings[${i}]`;
    if (seen.has(blessing.id)) problems.push(`${path}.id — повторяется: ${blessing.id}`);
    seen.add(blessing.id);
    if (blessing.nameKey === "") problems.push(`${path}.nameKey — нужен ключ названия`);

    const entries = Object.entries(blessing.modifiers);
    if (entries.length === 0) problems.push(`${path}.modifiers — нужен хотя бы один параметр`);
    for (const [stat, value] of entries) {
      if (!(LOADOUT_STATS as readonly string[]).includes(stat)) {
        problems.push(`${path}.modifiers.${stat} — неизвестный параметр`);
        continue;
      }
      const bound = LOADOUT_BOUNDS[stat as LoadoutStat];
      if (!(typeof value === "number" && value > 0 && value <= bound)) {
        problems.push(`${path}.modifiers.${stat} — от 0 (не включая) до ${bound}, сейчас ${String(value)}`);
      }
    }
  });
  return problems;
}

// --- Раскладка ----------------------------------------------------------------

/**
 * Сколько раз пробуется новое место, прежде чем смириться с соседством.
 * Конечное число: цикл в симуляции не должен зависеть от удачи генератора.
 */
const MAX_PLACE_ATTEMPTS = 12;

const scratch = createDirection();

/** Радиус круга вида, единицы; у огонька круга нет. */
function radiusOf(def: SecretsDef, kind: SecretKind): number {
  switch (kind) {
    case "shrine":
      return def.shrine.radius;
    case "hoard":
      return def.hoard.radius;
    case "stone":
      return def.stone.radius;
    case "wisp":
      return 0;
  }
}

function holdTicksOf(holdSec: number): number {
  return Math.round(holdSec * TICK_HZ);
}

/**
 * Бросить раскладку тайников. Поток приходит снаружи — создание мира заводит
 * его от `deriveSeed(seed, STREAM_SALT.secret)`; без колец поток не тратится.
 */
export function createSecretState(rng: Rng, def: SecretsDef, unitScale: number, bounds: WorldBounds): SecretState {
  const sites: SecretSite[] = [];
  const gap = def.minGapUnits * unitScale;

  def.rings.forEach((ring, ringIndex) => {
    for (let slot = 0; slot < ring.count; slot++) {
      const kind = ring.kinds[drawWeighted(rng, ring.kinds)].kind;
      // Огоньку места на карте нет: слот кольца лишь решает, что он будет в этом забеге.
      const site: SecretSite = {
        kind,
        ring: ringIndex,
        x: 0,
        y: 0,
        active: kind !== "wisp",
        visible: false,
        found: false,
        used: false,
        holdTicks: 0,
      };
      if (site.active) {
        const margin = radiusOf(def, kind) * unitScale;
        for (let attempt = 0; attempt < MAX_PLACE_ATTEMPTS; attempt++) {
          randomDirection(rng, scratch);
          const distance = rng.nextRange(ring.minRadius, ring.maxRadius) * unitScale;
          // Граница карты, если она есть, не выпускает тайник за край.
          site.x = clampToBounds(scratch.x * distance, Math.max(0, bounds.halfWidth - margin));
          site.y = clampToBounds(scratch.y * distance, Math.max(0, bounds.halfHeight - margin));
          if (isClear(sites, site.x, site.y, gap)) break;
        }
      }
      sites.push(site);
    }
  });

  return {
    rng,
    sites,
    manualBlessing: false,
    offer: null,
    blessings: [],
    foundLog: [],
    usedLog: [],
    blessingLog: [],
  };
}

function isClear(sites: readonly SecretSite[], x: number, y: number, gap: number): boolean {
  const gapSq = gap * gap;
  for (const other of sites) {
    if (!other.active) continue;
    const dx = other.x - x;
    const dy = other.y - y;
    if (dx * dx + dy * dy < gapSq) return false;
  }
  return true;
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
