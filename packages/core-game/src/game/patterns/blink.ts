import { createDirection, directionInArc, randomDirection } from "../sim/directions";
import { setHidden } from "../sim/hidden";
import { vectorLength } from "../sim/vector";
import type { World } from "../sim/world";
import type { PatternBehavior } from "./behavior";
import { createHeading, steerTowardPlayer, stopEnemy } from "./steering";

/** Фазы Кикиморы. Рендер читает их, чтобы таять, прятать и показывать метку. */
export const BLINK_PHASE = {
  /** идёт на игрока и бьёт касанием */
  chase: 0,
  /** тает на месте: урона не наносит, но его можно бить */
  fading: 1,
  /** нет на поле: не цель, не в сетке, не бьёт; на земле светится метка в точке появления */
  hidden: 2,
  /** встала в точке метки: видна и уязвима, но ещё не бьёт */
  appear: 3,
} as const;

/** Сколько враг тает перед исчезновением. */
export const BLINK_FADE_SEC = 0.25;

/**
 * Сколько враг стоит после появления, не нанося урона. Метка уже сказала, где он будет, и
 * это время — шаг в сторону, а не второй телеграф: без него появление на пути бегущего игрока
 * било бы в тот же тик.
 */
export const BLINK_APPEAR_SEC = 0.2;

/** Не ближе к игроку: на нём враг появляться не вправе, и это держит даже граница карты. */
export const BLINK_MIN_DISTANCE = 60;

/** Синус половины раствора дуги «вперёд по ходу игрока»: ±60°. */
const FORWARD_ARC_SIN = 0.866;

/** Игрок медленнее этого — «стоит», и дуги вперёд у него нет: направление любое. */
const STANDING_SPEED = 1;

const heading = createHeading();
const direction = createDirection();

/**
 * Подходит, тает, исчезает и появляется рядом с игроком там, где перед этим светилась метка.
 *
 * Игрок привыкает убегать по прямой, потому что враги догоняют его телом. Кикимора эту привычку
 * ломает: от неё не убежать, но к ней можно подготовиться — метка видна всё время, пока врага
 * нет на поле.
 *
 * Направление появления бросается один раз, когда враг начинает таять (`world.rng`, тем же
 * потоком, что остальные паттерны): дуга вперёд по ходу игрока или любая сторона, если он стоит.
 * Сама точка считается, когда враг исчезает, — от игрока, каким он стал за эти четверть секунды, —
 * и до появления не меняется. Телепорт делается сразу: враг лежит в слоте на месте метки, скрытый,
 * и снимок забега хранит точку в обычных координатах слота.
 */
export const blink: PatternBehavior = {
  update(world, index, dtSec) {
    const enemies = world.enemies;
    switch (enemies.phase[index]) {
      case BLINK_PHASE.chase:
        steerTowardPlayer(world, index, dtSec, heading);
        enemies.phaseTimer[index] += dtSec;
        if (enemies.phaseTimer[index] >= world.enemyTypes[enemies.type[index]].params.blinkEverySec) startFading(world, index);
        return;
      case BLINK_PHASE.fading:
        stopEnemy(world, index);
        if (tickTimer(world, index, dtSec)) startHidden(world, index);
        return;
      case BLINK_PHASE.hidden:
        stopEnemy(world, index);
        if (tickTimer(world, index, dtSec)) startAppear(world, index);
        return;
      default:
        stopEnemy(world, index);
        if (tickTimer(world, index, dtSec)) {
          enemies.phase[index] = BLINK_PHASE.chase;
          enemies.phaseTimer[index] = 0;
        }
    }
  },
};

function startFading(world: World, index: number): void {
  const enemies = world.enemies;
  const player = world.player;
  const speed = vectorLength(player.vx, player.vy);
  if (speed < STANDING_SPEED) {
    randomDirection(world.rng, direction);
  } else {
    directionInArc(world.rng, player.vx / speed, player.vy / speed, FORWARD_ARC_SIN, direction);
  }
  enemies.dirX[index] = direction.x;
  enemies.dirY[index] = direction.y;
  enemies.phase[index] = BLINK_PHASE.fading;
  enemies.phaseTimer[index] = BLINK_FADE_SEC;
  stopEnemy(world, index);
}

function startHidden(world: World, index: number): void {
  const enemies = world.enemies;
  const player = world.player;
  const type = world.enemyTypes[enemies.type[index]];
  const distance = type.params.blinkDistance;
  const minDistance = BLINK_MIN_DISTANCE * world.config.unitScale;
  const bounds = world.config.bounds;
  const limitX = bounds.halfWidth - type.radius;
  const limitY = bounds.halfHeight - type.radius;

  // Направление хранится в Float32 слота: длина выходит чуть не единичной, и расстояние до игрока
  // перестало бы быть ровно `blinkDistance`. Нормируем заново.
  const length = vectorLength(enemies.dirX[index], enemies.dirY[index]);
  let offsetX = length > 0 ? (enemies.dirX[index] / length) * distance : distance;
  let offsetY = length > 0 ? (enemies.dirY[index] / length) * distance : 0;

  let x = clampAxis(player.x + offsetX, limitX);
  let y = clampAxis(player.y + offsetY, limitY);
  const tooClose = (px: number, py: number): boolean => {
    const dx = px - player.x;
    const dy = py - player.y;
    return dx * dx + dy * dy < minDistance * minDistance;
  };
  if (tooClose(x, y)) {
    // Граница прижала точку к игроку: зеркалим по той оси, что упёрлась, — по другую сторону от него.
    if (x !== player.x + offsetX) offsetX = -offsetX;
    if (y !== player.y + offsetY) offsetY = -offsetY;
    x = clampAxis(player.x + offsetX, limitX);
    y = clampAxis(player.y + offsetY, limitY);
  }
  if (tooClose(x, y)) {
    // Карта в этом месте уже минимальной дистанции по одной оси: недостающее добираем по другой — той,
    // что граница не держит, — в ту же сторону, куда смотрело направление.
    const xPinned = x !== player.x + offsetX;
    const yPinned = y !== player.y + offsetY;
    if (!xPinned) {
      const need = Math.sqrt(Math.max(0, minDistance * minDistance - (y - player.y) * (y - player.y)));
      x = clampAxis(player.x + (offsetX < 0 ? -need : need), limitX);
    } else if (!yPinned) {
      const need = Math.sqrt(Math.max(0, minDistance * minDistance - (x - player.x) * (x - player.x)));
      y = clampAxis(player.y + (offsetY < 0 ? -need : need), limitY);
    }
  }

  enemies.x[index] = x;
  enemies.y[index] = y;
  // Предыдущая позиция — та же точка: рендер не должен «протянуть» невидимого врага через поле.
  enemies.prevX[index] = x;
  enemies.prevY[index] = y;
  enemies.phase[index] = BLINK_PHASE.hidden;
  enemies.phaseTimer[index] = type.params.telegraphSec;
  stopEnemy(world, index);
  setHidden(world, index, true);
}

function startAppear(world: World, index: number): void {
  const enemies = world.enemies;
  enemies.phase[index] = BLINK_PHASE.appear;
  enemies.phaseTimer[index] = BLINK_APPEAR_SEC;
  setHidden(world, index, false);
}

/** Уменьшить таймер фазы; `true` — фаза закончилась. */
function tickTimer(world: World, index: number, dtSec: number): boolean {
  world.enemies.phaseTimer[index] -= dtSec;
  return world.enemies.phaseTimer[index] <= 0;
}

/**
 * Ограничить значение границей карты; с бесконечной границей это тождество. Своя копия, а не
 * `clampToBounds` из `sim/world.ts`: реестр типов читает фазы отсюда при загрузке модуля, и
 * импорт мира замкнул бы цикл.
 */
function clampAxis(value: number, halfExtent: number): number {
  return value < -halfExtent ? -halfExtent : value > halfExtent ? halfExtent : value;
}
