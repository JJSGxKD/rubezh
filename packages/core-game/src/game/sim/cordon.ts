import type { CordonRingDef } from "@bh/shared-types";
import { CORDON_FORM_SEC, CORDON_PHASE } from "../patterns/cordon";
import { createDirection, randomRingOffset, ringDirection } from "./directions";
import { vectorLength } from "./vector";
import { clampToBounds, despawnEnemy, spawnEnemy, type World } from "./world";

/**
 * Кольцо стражей (docs/35-stage4-plan.md Р112, tasks/T-0170): плотный строй
 * вокруг неподвижного центра, который сжимается и не пускает игрока, пока
 * стражи не убиты или не вышло время. Здесь — состояние кольца и всё, что с
 * ним делает мир; как страж держит место — `patterns/cordon.ts`.
 *
 * Расстояния в состоянии хранятся уже умноженными на плотность экрана: тела
 * стражей и игрока считаются в тех же единицах, и пересчёта в горячем пути нет.
 * Случайность — только повороты кольца при старте (строя и, если есть, внутренних
 * врагов), из `world.rng`, как у события `ring`. Ни тригонометрии, ни `Math.random`: детерминизм между
 * движками (docs/26-stage2-plan.md, WP4.5).
 */

/** Чем закончилось кольцо (аналитика, `ring_ended`): прорвался, выстоял до конца времени, погиб. */
export type CordonOutcome = "broken" | "held" | "died";

/** Запись журнала о закончившемся кольце; `killed` — убитые стражи, а не исчезнувшие по времени. */
export interface CordonEnd {
  index: number;
  outcome: CordonOutcome;
  guards: number;
  killed: number;
  lifeSec: number;
  elapsedSec: number;
}

export interface CordonState {
  /** идёт ли кольцо; неактивное в контрольную сумму и в логику шага не входит */
  active: boolean;
  /** центр — точка, где стоял игрок в тик события; за игроком не идёт */
  centerX: number;
  centerY: number;
  /** текущий радиус строя */
  radius: number;
  minRadius: number;
  shrinkPerSec: number;
  /** сколько секунд кольцо ещё живёт */
  timeLeftSec: number;
  /** сколько колец началось в забеге; номер очередного кольца для аналитики */
  ringsStarted: number;
  /** секунда забега, на которой кольцо началось */
  startedAtSec: number;
  /** сколько стражей реально вышло в строй */
  guards: number;
  /** внутренние враги, ждущие своего появления: место уже выбрано, тип известен */
  pending: CordonPending[];
  /** сколько секунд до их появления */
  pendingLeftSec: number;
  /**
   * Журнал закончившихся колец для аналитики. В снимок и в контрольную сумму не
   * входит: после восстановления он пуст, поэтому событие не повторяется.
   */
  ended: CordonEnd[];
}

/** Внутренний враг, чьё место в строю уже выбрано, а появится он через `pendingLeftSec`. */
export interface CordonPending {
  typeIndex: number;
  x: number;
  y: number;
}

/** Сколько секунд телеграф внутреннего врага горит до его появления. */
export const CORDON_INNER_SEC = 1;

/** Во сколько раз ближе к центру, чем строй, появляются внутренние враги. */
export const CORDON_INNER_RADIUS_MUL = 0.5;

export function createCordonState(): CordonState {
  return {
    active: false,
    centerX: 0,
    centerY: 0,
    radius: 0,
    minRadius: 0,
    shrinkPerSec: 0,
    timeLeftSec: 0,
    ringsStarted: 0,
    startedAtSec: 0,
    guards: 0,
    pending: [],
    pendingLeftSec: 0,
    ended: [],
  };
}

const direction = createDirection();

/** Ниже этого расстояния направление выталкивания не определено. */
const MIN_PUSH_DISTANCE = 1e-3;

/**
 * Запустить кольцо. Одно за раз: пока оно идёт, второе событие пропускается
 * целиком. Стражи встают на радиусе кольца сразу и горят вспышкой
 * `CORDON_FORM_SEC` (Р166): не бьют и не толкают, пока она не погасла. Потолок
 * живых не мешает: стражи создаются, пока есть свободные слоты пула, не хватило —
 * встаёт сколько влезло. Ни один не встал — кольца нет.
 */
export function startCordon(world: World, typeIndex: number, count: number, ring: CordonRingDef): void {
  const state = world.cordon;
  if (state.active) return;

  const scale = world.config.unitScale;
  const radius = ring.radius * scale;
  const offset = randomRingOffset(world.rng);
  const enemies = world.enemies;
  const guardRadius = world.enemyTypes[typeIndex].radius;
  const bounds = world.config.bounds;
  const centerX = world.player.x;
  const centerY = world.player.y;
  let spawned = 0;
  for (let k = 0; k < count; k++) {
    ringDirection(offset, k, count, direction);
    const x = clampToBounds(centerX + direction.x * radius, bounds.halfWidth - guardRadius);
    const y = clampToBounds(centerY + direction.y * radius, bounds.halfHeight - guardRadius);
    const slot = spawnEnemy(world, typeIndex, x, y);
    if (slot < 0) break;
    // Место в строю — это направление: страж стоит на нём и дальше следует за сжатием.
    enemies.dirX[slot] = direction.x;
    enemies.dirY[slot] = direction.y;
    enemies.phase[slot] = CORDON_PHASE.forming;
    enemies.phaseTimer[slot] = CORDON_FORM_SEC;
    spawned++;
  }
  if (spawned === 0) return;

  state.active = true;
  state.centerX = centerX;
  state.centerY = centerY;
  state.radius = radius;
  state.minRadius = ring.minRadius * scale;
  state.shrinkPerSec = ring.shrinkPerSec * scale;
  state.timeLeftSec = ring.lifeSec;
  state.startedAtSec = world.stats.elapsedSec;
  state.guards = spawned;
  state.pending = [];
  state.pendingLeftSec = 0;
  planInner(world, ring, radius);
}

/**
 * Выбрать места внутренним врагам кольца: элита и босс выходят на половине
 * радиуса через `CORDON_INNER_SEC`, пока горит их телеграф. Записи, до которых
 * забег ещё не дошёл по времени, и враги, которых нет в мире, пропускаются без
 * ошибки. Второй поворот из `world.rng` берётся только если есть кого ставить:
 * кольцо без внутренних тратит случайность так же, как до Р166.
 */
function planInner(world: World, ring: CordonRingDef, radius: number): void {
  const entries = (ring.inner ?? []).filter((entry) => entry.fromSec === undefined || world.stats.elapsedSec >= entry.fromSec);
  const typeIndexes: number[] = [];
  for (const entry of entries) {
    const typeIndex = world.enemyTypes.findIndex((type) => type.id === entry.enemy);
    if (typeIndex < 0) continue;
    for (let k = 0; k < entry.count; k++) typeIndexes.push(typeIndex);
  }
  if (typeIndexes.length === 0) return;

  const state = world.cordon;
  const bounds = world.config.bounds;
  const offset = randomRingOffset(world.rng);
  for (let k = 0; k < typeIndexes.length; k++) {
    ringDirection(offset, k, typeIndexes.length, direction);
    const typeIndex = typeIndexes[k];
    const innerRadius = world.enemyTypes[typeIndex].radius;
    state.pending.push({
      typeIndex,
      x: clampToBounds(state.centerX + direction.x * radius * CORDON_INNER_RADIUS_MUL, bounds.halfWidth - innerRadius),
      y: clampToBounds(state.centerY + direction.y * radius * CORDON_INNER_RADIUS_MUL, bounds.halfHeight - innerRadius),
    });
  }
  state.pendingLeftSec = CORDON_INNER_SEC;
}

/** Выпустить внутренних врагов, когда телеграф догорел; не нашлось слота — враг не выходит. */
function releasePending(world: World, dtSec: number): void {
  const state = world.cordon;
  if (state.pending.length === 0) return;

  state.pendingLeftSec -= dtSec;
  if (state.pendingLeftSec > 0) return;
  for (const entry of state.pending) spawnEnemy(world, entry.typeIndex, entry.x, entry.y);
  state.pending = [];
  state.pendingLeftSec = 0;
}

/** Живые стражи кольца. */
function countGuards(world: World): number {
  const enemies = world.enemies;
  let guards = 0;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 1 && world.enemyTypes[enemies.type[i]].anchored) guards++;
  }
  return guards;
}

/**
 * Закрыть кольцо и записать исход в журнал: единственное место, где кольцо
 * кончается, поэтому на каждое приходится ровно одна запись. `killed` — сколько
 * из вышедших стражей уже нет к этому моменту (по времени оставшиеся исчезают
 * позже и убитыми не считаются).
 */
function endCordon(world: World, outcome: CordonOutcome): void {
  const state = world.cordon;
  const elapsedSec = world.stats.elapsedSec;
  state.ended.push({
    index: state.ringsStarted,
    outcome,
    guards: state.guards,
    killed: Math.max(0, state.guards - countGuards(world)),
    lifeSec: Math.max(0, elapsedSec - state.startedAtSec),
    elapsedSec,
  });
  state.ringsStarted++;
  state.active = false;
  // Кольцо кончилось раньше, чем вышли внутренние: невышедшие не появятся.
  state.pending = [];
  state.pendingLeftSec = 0;
}

/**
 * Смерть игрока закрывает активное кольцо исходом `died`; экран «второго шанса»
 * кольцо не возвращает. Игрок гибнет в конце шага, после `updateCordon`, а сцена
 * после этого шаги прекращает — поэтому её зовёт и сцена, иначе исход самого
 * частого случая не дошёл бы до аналитики. Вернуть `true` — кольцо закрыто.
 */
export function settleCordonDeath(world: World): boolean {
  if (!world.cordon.active || world.player.alive) return false;
  endCordon(world, "died");
  return true;
}

export interface CordonEvents {
  ended: CordonEnd[];
  cursor: number;
}

/** Новые записи журнала после курсора и сдвинутый курсор. Мир не меняется. */
export function takeCordonEvents(world: World, cursor: number): CordonEvents {
  const { ended } = world.cordon;
  return { ended: ended.slice(cursor), cursor: ended.length };
}

/**
 * Шаг кольца: сжатие, время и конец. Кончается оно, когда живых стражей не
 * осталось или вышло время; по времени стражи исчезают без убийства — без
 * добычи, опыта и счёта (`despawnEnemy`, а не `killEnemy`).
 */
export function updateCordon(world: World, dtSec: number): void {
  const state = world.cordon;
  if (!state.active) return;

  if (settleCordonDeath(world)) return;

  releasePending(world, dtSec);
  state.radius = Math.max(state.minRadius, state.radius - state.shrinkPerSec * dtSec);
  state.timeLeftSec -= dtSec;

  if (countGuards(world) === 0) {
    endCordon(world, "broken");
    return;
  }
  if (state.timeLeftSec > 0) return;

  // Исход фиксируется до исчезновения стражей: после него живых уже не осталось бы.
  endCordon(world, "held");
  const enemies = world.enemies;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 1 && world.enemyTypes[enemies.type[i]].anchored) despawnEnemy(world, i);
  }
}

/**
 * Тело стража для игрока непроходимо: игрок выталкивается из него вдоль
 * нормали, а составляющая скорости вглубь гасится — вдоль остаётся, поэтому он
 * скользит по строю, а не прилипает. Два прохода: два стража рядом выталкивают
 * по очереди. Другие враги стражей не толкают — это дело одного игрока.
 */
export function pushPlayerOutOfGuards(world: World): void {
  const state = world.cordon;
  const player = world.player;
  if (!state.active || !player.alive) return;

  const enemies = world.enemies;
  const playerRadius = world.config.player.radius;
  const bounds = world.config.bounds;

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < enemies.count; i++) {
      if (enemies.alive[i] === 0) continue;
      const type = world.enemyTypes[enemies.type[i]];
      if (!type.solid) continue;
      // Пока горит вспышка строя, страж не толкает.
      if (enemies.phase[i] === CORDON_PHASE.forming) continue;

      const dx = player.x - enemies.x[i];
      const dy = player.y - enemies.y[i];
      const distance = vectorLength(dx, dy);
      const reach = type.radius + playerRadius;
      if (distance >= reach) continue;

      // Совпавшие центры — сдвиг по оси X: направление есть, деления на ноль нет.
      const nx = distance < MIN_PUSH_DISTANCE ? 1 : dx / distance;
      const ny = distance < MIN_PUSH_DISTANCE ? 0 : dy / distance;
      const push = reach - distance;
      player.x += nx * push;
      player.y += ny * push;

      const inward = player.vx * nx + player.vy * ny;
      if (inward < 0) {
        player.vx -= inward * nx;
        player.vy -= inward * ny;
      }
    }
  }
  // Выталкивание не должно унести игрока за стену карты.
  player.x = clampToBounds(player.x, bounds.halfWidth - playerRadius);
  player.y = clampToBounds(player.y, bounds.halfHeight - playerRadius);
}
