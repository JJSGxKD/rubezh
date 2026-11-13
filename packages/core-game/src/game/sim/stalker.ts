import type { MapDef, StalkerAppearDef, StalkerDef, StalkerRange } from "@bh/shared-types";
import { isBoss, PATTERN_TRAITS } from "../patterns";
import { createDirection, randomDirection } from "./directions";
import { pushSimEvent, SIM_EVENT } from "./events";
import { spawnRadiusUnits } from "./map-types";
import type { Rng } from "./rng";
import { despawnStalker, spawnStalker, stalkerAlive } from "./stalker-body";
import { clampToBounds, TICK_HZ, type World } from "./world";

/**
 * Директор неубиваемого преследователя (Р205, tasks/T-0423): когда и откуда приходит Карачун. Тело — как он
 * ходит, что делают с ним удары и что делает его касание — лежит в `sim/stalker-body.ts`; здесь только
 * расписание появлений.
 *
 * Одно появление — цепочка фаз: `waiting` (ждёт отметку) → `omen` (на земле проступает иней, игрок видит,
 * откуда он выйдет) → `chase` (он идёт на игрока, погоня ограничена по времени) → `fading` (он стоит,
 * не бьёт и не толкается, а потом исчезает) → снова `waiting` с паузой. `off` — директора в мире нет:
 * правил нет, пролог, «Лёгкая» или новичок ниже `minAccountLevel`.
 *
 * Случайность — собственный поток `world.stalker.rng`, а не `world.rng`: иначе появление Карачуна сдвинуло
 * бы все golden-прогоны и предложения уровней. Поток тратится одинаково при любой игре: первая отметка —
 * при создании мира, направление и длина погони — в начале предвестия, пауза — в конце появления. Условия,
 * при которых он не приходит (босс, строй, разлом), бросков не добавляют: директор просто ждёт.
 *
 * Ни одной проверки id врага: тип берётся из состояния тела (`stalkerBody.typeIndex`).
 */
export type StalkerPhase = "off" | "waiting" | "omen" | "chase" | "fading";

export const STALKER_PHASES: readonly StalkerPhase[] = ["off", "waiting", "omen", "chase", "fading"];

/** Чем кончилось появление: растворился сам, срезан строем стражей или игрок погиб. */
export type StalkerOutcome = "faded" | "cut" | "died";

/** Запись о законченном появлении — основа события аналитики `stalker_ended` (T-0427). */
export interface StalkerEnd {
  /** номер появления в забеге, с нуля */
  index: number;
  outcome: StalkerOutcome;
  /** касаний, дошедших до игрока */
  hits: number;
  /** ударов оружия, которые сдвинули его с места */
  pushes: number;
  /** сколько раз он был отброшен дальше `farDistance` и возник ближе */
  relocations: number;
  /** сколько секунд он провёл на поле; предвестие без выхода — ноль */
  lifeSec: number;
  /** секунда забега, на которой появление кончилось */
  elapsedSec: number;
}

export interface StalkerState {
  /** собственный поток случайности: направление, длина погони и паузы берутся из него */
  rng: Rng;
  /**
   * Правила появления из контента; `null` — правил в мире нет. Неизменны, в снимок забега не входят: мир
   * создаётся из того же контента.
   */
  appear: StalkerAppearDef | null;
  phase: StalkerPhase;
  /** тик, с которого можно начинать предвестие (в фазе `waiting`) */
  nextOmenTick: number;
  /** точка выхода: в фазе `omen` — где проступает иней */
  x: number;
  y: number;
  /** тики до конца фазы `omen` или `fading` */
  phaseTicks: number;
  /** тики погони, оставшиеся у этого появления; идут и в повторном предвестии */
  chaseTicks: number;
  /** номер текущего появления в забеге с нуля и счётчики текущего — для аналитики */
  index: number;
  hits: number;
  pushes: number;
  relocations: number;
  /** тик первого выхода текущего появления; −1 — он ещё не выходил */
  appearedTick: number;
  /** журнал законченных появлений для сцены; в снимок не входит */
  ended: StalkerEnd[];
}

/**
 * Состояние нового мира. Нет правил, пролог, «Лёгкая» или новичок (`active` ложно) — фаза `off`, иначе
 * `waiting`, и первая отметка бросается сразу: `fromSec` плюс случайная задержка.
 */
export function createStalkerState(rng: Rng, def: StalkerDef | undefined, typeIndex: number, active: boolean): StalkerState {
  const appear = def === undefined || typeIndex < 0 ? null : def.appear;
  const state: StalkerState = {
    rng,
    appear,
    phase: appear !== null && active ? "waiting" : "off",
    nextOmenTick: 0,
    x: 0,
    y: 0,
    phaseTicks: 0,
    chaseTicks: 0,
    index: 0,
    hits: 0,
    pushes: 0,
    relocations: 0,
    appearedTick: -1,
    ended: [],
  };
  if (appear !== null) {
    state.nextOmenTick = Math.round((appear.fromSec + rng.nextRange(appear.firstDelaySec.min, appear.firstDelaySec.max)) * TICK_HZ);
  }
  return state;
}

function lerpRange(from: StalkerRange, to: StalkerRange, t: number): StalkerRange {
  return { min: from.min + (to.min - from.min) * t, max: from.max + (to.max - from.max) * t };
}

/**
 * Коридор паузы на секунде забега: `gapSec` на `fromSec` и раньше, `lateGapSec` на `lateAtSec` и позже, между
 * ними — линейно. Из коридора поток бросает число.
 */
export function stalkerGapRange(appear: StalkerAppearDef, elapsedSec: number): StalkerRange {
  const span = appear.lateAtSec - appear.fromSec;
  const t = span > 0 ? Math.min(1, Math.max(0, (elapsedSec - appear.fromSec) / span)) : 1;
  return lerpRange(appear.gapSec, appear.lateGapSec, t);
}

function rollGapTicks(world: World, appear: StalkerAppearDef): number {
  const range = stalkerGapRange(appear, world.stats.tick / TICK_HZ);
  return Math.max(1, Math.round(world.stalker.rng.nextRange(range.min, range.max) * TICK_HZ));
}

const direction = createDirection();

/** Живой враг ранга «босс»: Страж рубежа тоже. */
function bossAlive(world: World): boolean {
  const enemies = world.enemies;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 1 && isBoss(world.enemyTypes[enemies.type[i]])) return true;
  }
  return false;
}

/** Открытый и не закрытый разлом Нави: пока волна его элит жива, Карачун не приходит. */
function riftOpen(world: World): boolean {
  for (const site of world.secrets.sites) {
    if (site.kind === "rift" && site.opened && !site.used) return true;
  }
  return false;
}

/** Точка на расстоянии `appearDistance` от игрока по направлению; в границах карты. */
function setOmenPoint(world: World, appear: StalkerAppearDef, dirX: number, dirY: number): void {
  const scale = world.config.unitScale;
  const radius = world.enemyTypes[world.stalkerBody.typeIndex].radius;
  const bounds = world.config.bounds;
  const state = world.stalker;
  state.x = clampToBounds(world.player.x + dirX * appear.appearDistance * scale, bounds.halfWidth - radius);
  state.y = clampToBounds(world.player.y + dirY * appear.appearDistance * scale, bounds.halfHeight - radius);
}

function pushOmenEvent(world: World, appear: StalkerAppearDef): void {
  pushSimEvent(world.events, { kind: SIM_EVENT.stalkerOmen, x: world.stalker.x, y: world.stalker.y, radius: appear.omenSec, tick: world.stats.tick });
}

/** Закрыть появление: запись в журнал, пауза и снова ожидание. Тело при `died` остаётся — его уберёт второй шанс. */
function endAppearance(world: World, appear: StalkerAppearDef, outcome: StalkerOutcome): void {
  const state = world.stalker;
  if (outcome !== "died") despawnStalker(world);
  const tick = world.stats.tick;
  state.ended.push({
    index: state.index,
    outcome,
    hits: state.hits,
    pushes: state.pushes,
    relocations: state.relocations,
    lifeSec: state.appearedTick < 0 ? 0 : (tick - state.appearedTick) / TICK_HZ,
    elapsedSec: tick / TICK_HZ,
  });
  state.index++;
  state.phase = "waiting";
  state.phaseTicks = 0;
  state.chaseTicks = 0;
  state.nextOmenTick = tick + rollGapTicks(world, appear);
}

/**
 * Игрок погиб посреди появления: исход `died`. Игрок гибнет в конце шага, а сцена после этого шаги
 * прекращает, поэтому её зовёт и сцена, и второй шанс — иначе исход самого частого случая не дошёл бы до
 * аналитики. Вернуть `true` — появление закрыто. Повторный вызов ничего не делает.
 */
export function settleStalkerDeath(world: World): boolean {
  const state = world.stalker;
  const appear = state.appear;
  if (appear === null || world.player.alive) return false;
  if (state.phase !== "omen" && state.phase !== "chase" && state.phase !== "fading") return false;
  endAppearance(world, appear, "died");
  return true;
}

/**
 * Второй шанс: появление закрыто (если шло), Карачуна на поле нет — все враги убраны, — а следующее
 * предвестие не раньше обычной паузы от момента продолжения. Зовётся из `applyContinue` до уборки врагов.
 */
export function resetStalkerOnContinue(world: World): void {
  const state = world.stalker;
  const appear = state.appear;
  if (appear === null || state.phase === "off") return;
  settleStalkerDeath(world);
  despawnStalker(world);
  state.phase = "waiting";
  state.phaseTicks = 0;
  state.nextOmenTick = Math.max(state.nextOmenTick, world.stats.tick + rollGapTicks(world, appear));
}

function startOmen(world: World, appear: StalkerAppearDef): void {
  const state = world.stalker;
  randomDirection(state.rng, direction);
  state.chaseTicks = Math.round(state.rng.nextRange(appear.chaseSec.min, appear.chaseSec.max) * TICK_HZ);
  setOmenPoint(world, appear, direction.x, direction.y);
  state.hits = 0;
  state.pushes = 0;
  state.relocations = 0;
  state.appearedTick = -1;
  state.phase = "omen";
  state.phaseTicks = Math.round(appear.omenSec * TICK_HZ);
  pushOmenEvent(world, appear);
}

/**
 * Команда разработчика «призвать Карачуна» (стенд эффектов, tasks/T-0425): начать предвестие сейчас же, в
 * обход отметки, паузы и блокировок (босс, строй, разлом). Идущее появление не перебивает; нет тела или
 * игрока — отказ. Пока забег не получил правила из контента (подключение — T-0424), `fallback` их ставит:
 * команда работает только в забеге разработчика, где правила и так не влияют на исход. Поток случайности
 * тратится как при обычном предвестии: направление и длина погони бросаются из него же.
 */
export function summonStalker(world: World, fallback?: StalkerDef): boolean {
  const state = world.stalker;
  if (state.appear === null && fallback !== undefined) equipStalker(world, fallback);
  const appear = state.appear;
  if (appear === null || world.stalkerBody.typeIndex < 0 || !world.player.alive) return false;
  if (state.phase === "omen" || state.phase === "chase" || state.phase === "fading") return false;
  startOmen(world, appear);
  return true;
}

/** Выдать миру без правил правила из контента: тело и появление. Нет типа врага в мире — ничего не меняет. */
function equipStalker(world: World, def: StalkerDef): void {
  const typeIndex = world.enemyTypes.findIndex((type) => type.id === def.enemy);
  if (typeIndex < 0) return;
  world.stalkerBody.rules = def.body;
  world.stalkerBody.typeIndex = typeIndex;
  world.stalker.appear = def.appear;
}

function stepWaiting(world: World, appear: StalkerAppearDef): void {
  const state = world.stalker;
  if (world.stats.tick < state.nextOmenTick) return;
  // Нельзя начать — ждём следующего тика, ничего не бросая: поток от блокировок не зависит.
  if (!world.player.alive || world.cordon.active || riftOpen(world) || bossAlive(world)) return;
  startOmen(world, appear);
}

function stepOmen(world: World, appear: StalkerAppearDef): void {
  const state = world.stalker;
  // Повторное предвестие (после отброса далеко) идёт из времени погони: убежать нельзя, дотянуть до конца можно.
  if (state.relocations > 0) {
    state.chaseTicks--;
    if (state.chaseTicks <= 0) {
      endAppearance(world, appear, "faded");
      return;
    }
  }
  state.phaseTicks--;
  if (state.phaseTicks > 0) return;

  // Пул врагов полон — повтор на следующем тике.
  if (spawnStalker(world, world.stalkerBody.typeIndex, state.x, state.y) < 0) return;
  state.phase = "chase";
  if (state.appearedTick < 0) state.appearedTick = world.stats.tick;
  pushSimEvent(world.events, { kind: SIM_EVENT.stalkerAppear, x: state.x, y: state.y, radius: 0, tick: world.stats.tick });
}

function stepChase(world: World, appear: StalkerAppearDef): void {
  const state = world.stalker;
  if (stalkerAlive(world) === 0) {
    // Тела нет, а погоня идёт: так бывает только при битом снимке — закрываем, а не стоим вечно.
    endAppearance(world, appear, "cut");
    return;
  }
  const slot = world.stalkerBody.slot;
  const enemies = world.enemies;
  state.chaseTicks--;
  if (state.chaseTicks <= 0) {
    state.phase = "fading";
    state.phaseTicks = Math.max(1, Math.round(appear.fadeSec * TICK_HZ));
    pushSimEvent(world.events, { kind: SIM_EVENT.stalkerFade, x: enemies.x[slot], y: enemies.y[slot], radius: appear.fadeSec, tick: world.stats.tick });
    return;
  }

  const dx = enemies.x[slot] - world.player.x;
  const dy = enemies.y[slot] - world.player.y;
  const far = appear.farDistance * world.config.unitScale;
  const distanceSq = dx * dx + dy * dy;
  if (distanceSq <= far * far) return;

  // Оттолкнули далеко: растворяется и после предвестия возникает ближе по тому же лучу от игрока.
  const distance = Math.sqrt(distanceSq);
  despawnStalker(world);
  setOmenPoint(world, appear, dx / distance, dy / distance);
  state.relocations++;
  state.phase = "omen";
  state.phaseTicks = Math.round(appear.omenSec * TICK_HZ);
  pushOmenEvent(world, appear);
}

function stepFading(world: World, appear: StalkerAppearDef): void {
  const state = world.stalker;
  state.phaseTicks--;
  if (state.phaseTicks > 0) return;
  endAppearance(world, appear, "faded");
}

/**
 * Шаг директора. Зовётся из `stepWorld` после кольца стражей и до перестройки сетки: вышедший Карачун
 * попадает в сетку того же тика.
 */
export function stepStalker(world: World): void {
  const state = world.stalker;
  const appear = state.appear;
  if (appear === null || state.phase === "off") return;

  if (state.phase === "waiting") {
    stepWaiting(world, appear);
    return;
  }
  if (settleStalkerDeath(world)) return;
  // Строй встал — Карачун растворяется на этом же тике: проход закрывать двумя угрозами сразу нечестно.
  if (world.cordon.active) {
    endAppearance(world, appear, "cut");
    return;
  }
  switch (state.phase) {
    case "omen":
      stepOmen(world, appear);
      return;
    case "chase":
      stepChase(world, appear);
      return;
    case "fading":
      stepFading(world, appear);
      return;
  }
}

/**
 * Проблемы карт для правил появления: точка выхода обязана помещаться на виду у самого узкого экрана, а
 * `farDistance` — в кольцо спавна. Видимая область нормализована по площади (Р14), поэтому короткая
 * сторона стоящей камеры на самом вытянутом экране — `√(viewAreaIdle / maxAspect)`; игрок в её центре, и
 * точка выхода плюс радиус тела не должны выходить за половину. Иначе предвестие ушло бы за край экрана.
 */
export function findStalkerMapProblems(def: StalkerDef, maps: readonly MapDef[]): string[] {
  const problems: string[] = [];
  const appear = def.appear;
  if (appear === undefined) return problems;
  const bodyRadius = PATTERN_TRAITS.stalker.radius;
  for (const map of maps) {
    const camera = map.camera;
    const half = 0.5 * Math.sqrt(camera.viewAreaIdle / Math.max(1, camera.maxAspect));
    if (appear.appearDistance + bodyRadius > half) {
      problems.push(
        `stalker.appear.appearDistance: карта ${map.id} — ${appear.appearDistance} с телом ${bodyRadius} не помещается в ${Math.floor(half)}: половину короткой стороны стоящей камеры на самом узком экране`,
      );
    }
    const spawn = spawnRadiusUnits(camera);
    if (appear.farDistance > spawn) {
      problems.push(`stalker.appear.farDistance: карта ${map.id} — ${appear.farDistance} дальше радиуса кольца спавна ${Math.floor(spawn)}`);
    }
  }
  return problems;
}
