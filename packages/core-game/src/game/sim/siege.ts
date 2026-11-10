import type { SiegeDef } from "@bh/shared-types";
import { startCordon } from "./cordon";
import { createDirection, randomRingOffset, ringDirection } from "./directions";
import type { Rng } from "./rng";
import { elitePoolAt, radiusOf } from "./secrets-rules";
import { siegeCount } from "./siege-rules";
import { spawnOnRing } from "./spawner";
import { TICK_HZ, type World } from "./world";

/**
 * Осада стоящего (docs/35-stage4-plan.md, Р197; tasks/T-0392): рубеж берёт в осаду того, кто после
 * `fromSec` долго стоит в одном круге. Правила и числа — `content/siege.ts`; это шаг осады, зовёт его
 * директор спавна: мир без директора (стенды, сценарные эталоны) осады не знает.
 *
 * - **якорь** — позиция игрока, с которой началось стояние; игрок в круге `radius` вокруг неё — счётчик
 *   растёт, вышел — якорь переезжает, счётчик с нуля. Счётчик в тиках, как стояние в тайниках;
 * - **предупреждение** — за `warnSec` до конца отсчёта: событие `warn`, сцена рисует кольцо на земле;
 * - **осада** — строй стражей с центром в якоре и кольцо элит; после неё перезарядка `cooldownSec`;
 * - **рост** — каждая осада сильнее прежней в `growth` раз до `maxLevel`; `calmSec` подряд вне осады
 *   снимают один уровень.
 *
 * Тайник с законным стоянием (капище, клад, древо-оберег) счётчик сбрасывает: в его круге осады нет.
 *
 * Случайность — только собственный поток `world.siege.rng` (`STREAM_SALT.siege`): общий `world.rng`
 * осада не трогает ни разу, иначе каждая осада сдвигала бы предложения уровней и golden-прогоны.
 * Строй и элиты получают поток параметром, ступень врага тоже бросается из него. Только целочисленная
 * арифметика и умножение: приближённая математика расходится между JS-движками.
 */

export { findSiegeProblems, siegeCount } from "./siege-rules";

/** Что осада сообщает сцене и оболочке; журнал в снимок не входит, после восстановления он пуст. */
export type SiegeEvent =
  | { kind: "warn"; x: number; y: number; radius: number; leftSec: number; level: number; elapsedSec: number }
  | { kind: "start"; level: number; guards: number; elites: number; elapsedSec: number }
  | { kind: "end"; level: number; elapsedSec: number };

export interface SiegeState {
  /** собственный поток случайности: `world.rng` осада не трогает */
  rng: Rng;
  /** якорь поставлен: до `fromSec` его нет */
  anchored: boolean;
  anchorX: number;
  anchorY: number;
  /** сколько тиков подряд игрок простоял в круге вокруг якоря */
  holdTicks: number;
  /** кольцо предупреждения горит: до осады остались считаные секунды */
  warned: boolean;
  /** уровень следующей осады: от 0 до `maxLevel` */
  level: number;
  /** идёт осада: строй стоит */
  active: boolean;
  /** уровень идущей осады: `level` к её началу */
  activeLevel: number;
  /** сколько тиков перезарядки осталось */
  cooldownTicks: number;
  /** сколько тиков подряд вне осады: по `calmSec` снимают один уровень */
  calmTicks: number;
  /** сколько осад было в забеге */
  count: number;
  log: SiegeEvent[];
}

export function createSiegeState(rng: Rng): SiegeState {
  return {
    rng,
    anchored: false,
    anchorX: 0,
    anchorY: 0,
    holdTicks: 0,
    warned: false,
    level: 0,
    active: false,
    activeLevel: 0,
    cooldownTicks: 0,
    calmTicks: 0,
    count: 0,
    log: [],
  };
}

const direction = createDirection();

function ticksOf(sec: number): number {
  return Math.round(sec * TICK_HZ);
}

/** Виды тайников, в круге которых стоят законно: за ними приходят, а не от них прячутся. */
function isHoldKind(kind: string): boolean {
  return kind === "shrine" || kind === "hoard" || kind === "tree";
}

function standsAtHoldSite(world: World): boolean {
  const player = world.player;
  for (const site of world.secrets.sites) {
    if (!site.active || site.used || !isHoldKind(site.kind)) continue;
    const radius = radiusOf(world.secretRules, site.kind) * world.config.unitScale;
    const dx = player.x - site.x;
    const dy = player.y - site.y;
    if (dx * dx + dy * dy <= radius * radius) return true;
  }
  return false;
}

function outsideCircle(world: World, state: SiegeState, rules: SiegeDef): boolean {
  const radius = rules.radius * world.config.unitScale;
  const dx = world.player.x - state.anchorX;
  const dy = world.player.y - state.anchorY;
  return dx * dx + dy * dy > radius * radius;
}

function anchorAtPlayer(world: World, state: SiegeState): void {
  state.anchored = true;
  state.anchorX = world.player.x;
  state.anchorY = world.player.y;
  state.holdTicks = 0;
  state.warned = false;
}

/**
 * Один тик осады. Вызывается директором до шага мира и в паузе выбора не идёт вместе с ним: счётчики
 * считают вызовы, а не секунды, поэтому директор обязан звать её раз за шаг мира.
 */
export function updateSiege(world: World): void {
  const rules = world.siegeRules;
  if (rules === null || !world.player.alive) return;
  if (world.stats.tick < ticksOf(rules.fromSec)) return;
  const state = world.siege;

  if (state.active) {
    // Осада идёт, пока стоит строй: пал или вышел срок — перезарядка.
    if (world.cordon.active) return;
    endSiege(world, rules, state);
  } else {
    calm(rules, state);
  }

  if (state.cooldownTicks > 0) {
    state.cooldownTicks--;
    anchorAtPlayer(world, state);
    return;
  }
  if (standsAtHoldSite(world) || !state.anchored || outsideCircle(world, state, rules)) {
    anchorAtPlayer(world, state);
    return;
  }

  state.holdTicks++;
  const holdTicks = ticksOf(rules.holdSec);
  if (!state.warned && state.holdTicks >= holdTicks - ticksOf(rules.warnSec)) warn(world, rules, state);
  if (state.holdTicks >= holdTicks) startSiege(world, rules, state);
}

/** Вне осады подряд `calmSec` — на уровень ниже: игрок, который ушёл со стоянки, отыгрывает рост. */
function calm(rules: SiegeDef, state: SiegeState): void {
  state.calmTicks++;
  if (state.calmTicks < ticksOf(rules.calmSec)) return;
  state.calmTicks = 0;
  if (state.level > 0) state.level--;
}

function warn(world: World, rules: SiegeDef, state: SiegeState): void {
  state.warned = true;
  state.log.push({
    kind: "warn",
    x: state.anchorX,
    y: state.anchorY,
    radius: rules.radius * world.config.unitScale,
    leftSec: rules.warnSec,
    level: state.level,
    elapsedSec: world.stats.elapsedSec,
  });
}

function startSiege(world: World, rules: SiegeDef, state: SiegeState): void {
  const level = state.level;
  // Второе кольцо при стоящем не ставится, как у события таймлайна: осада тогда — элиты и тот же строй.
  const guardType = world.enemyTypes.findIndex((type) => type.id === rules.cordon.enemy);
  let guards = 0;
  if (guardType >= 0 && !world.cordon.active) {
    const count = siegeCount(rules.cordon.count, rules.growth, level);
    startCordon(world, guardType, count, rules.cordon.ring, { x: state.anchorX, y: state.anchorY, rng: state.rng });
    guards = world.cordon.active ? world.cordon.guards : 0;
  }
  const elites = sendElites(world, siegeCount(rules.eliteCount, rules.growth, level));

  state.active = true;
  state.activeLevel = level;
  state.count++;
  state.holdTicks = 0;
  state.warned = false;
  state.calmTicks = 0;
  state.level = Math.min(rules.maxLevel, level + 1);
  state.log.push({ kind: "start", level, guards, elites, elapsedSec: world.stats.elapsedSec });
}

/**
 * Кольцо элит вокруг игрока снаружи экрана, как событие `ring`: мимо потолка живых (стоящий всегда
 * в толпе, и потолок отменил бы осаду), упирается только пул слотов. Типы — те элиты, что таймлайн
 * к этой секунде уже выпускал, как у разлома Нави; пул пуст — элит нет.
 */
function sendElites(world: World, count: number): number {
  const pool = elitePoolAt(world.secrets.elitePool, world.stats.elapsedSec);
  if (count <= 0 || pool.length === 0) return 0;

  const rng = world.siege.rng;
  const offset = randomRingOffset(rng);
  let sent = 0;
  for (let k = 0; k < count; k++) {
    const type = pool[rng.nextInt(0, pool.length)];
    ringDirection(offset, k, count, direction);
    if (spawnOnRing(world, type, direction.x, direction.y, rng) < 0) break;
    sent++;
  }
  return sent;
}

function endSiege(world: World, rules: SiegeDef, state: SiegeState): void {
  state.active = false;
  state.cooldownTicks = ticksOf(rules.cooldownSec);
  state.calmTicks = 0;
  state.holdTicks = 0;
  state.log.push({ kind: "end", level: state.activeLevel, elapsedSec: world.stats.elapsedSec });
}

/**
 * «Второй шанс» убирает с поля всех врагов и возвращает игрока на то же место: отсчёт стояния начинается
 * заново, а кольцо на земле гаснет. Уровень, перезарядка и спад остаются — смерть осаду не отменяет.
 */
export function resetSiege(world: World): void {
  const state = world.siege;
  state.anchored = false;
  state.holdTicks = 0;
  state.warned = false;
}

/** Кольцо предупреждения для сцены; `null` — кольца нет. Прогресс — от 0 в начале предупреждения до 1 в момент осады. */
export interface SiegeWarning {
  x: number;
  y: number;
  radius: number;
  progress: number;
}

export function siegeWarning(world: World): SiegeWarning | null {
  const rules = world.siegeRules;
  const state = world.siege;
  if (rules === null || !state.warned || state.active) return null;
  const warnTicks = Math.max(1, ticksOf(rules.warnSec));
  const left = ticksOf(rules.holdSec) - state.holdTicks;
  const progress = 1 - left / warnTicks;
  return {
    x: state.anchorX,
    y: state.anchorY,
    radius: rules.radius * world.config.unitScale,
    progress: progress < 0 ? 0 : progress > 1 ? 1 : progress,
  };
}

export interface SiegeEvents {
  events: SiegeEvent[];
  cursor: number;
}

/** Новые записи журнала после курсора и сдвинутый курсор. Мир не меняется. */
export function takeSiegeEvents(world: World, cursor: number): SiegeEvents {
  const { log } = world.siege;
  return { events: log.slice(cursor), cursor: log.length };
}
