import type { CordonRingDef } from "@bh/shared-types";
import { CORDON_PHASE } from "../patterns/cordon";
import { createDirection, randomRingOffset, ringDirection } from "./directions";
import { spawnOnRing } from "./spawner";
import { vectorLength } from "./vector";
import { clampToBounds, despawnEnemy, type World } from "./world";

/**
 * Кольцо стражей (docs/35-stage4-plan.md Р112, tasks/T-0170): плотный строй
 * вокруг неподвижного центра, который сжимается и не пускает игрока, пока
 * стражи не убиты или не вышло время. Здесь — состояние кольца и всё, что с
 * ним делает мир; как страж держит место — `patterns/cordon.ts`.
 *
 * Расстояния в состоянии хранятся уже умноженными на плотность экрана: тела
 * стражей и игрока считаются в тех же единицах, и пересчёта в горячем пути нет.
 * Случайность — только поворот кольца при старте, из `world.rng`, как у
 * события `ring`. Ни тригонометрии, ни `Math.random`: детерминизм между
 * движками (docs/26-stage2-plan.md, WP4.5).
 */

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
}

export function createCordonState(): CordonState {
  return { active: false, centerX: 0, centerY: 0, radius: 0, minRadius: 0, shrinkPerSec: 0, timeLeftSec: 0 };
}

const direction = createDirection();

/** Ниже этого расстояния направление выталкивания не определено. */
const MIN_PUSH_DISTANCE = 1e-3;

/**
 * Запустить кольцо. Одно за раз: пока оно идёт, второе событие пропускается
 * целиком. Потолок живых не мешает: стражи создаются, пока есть свободные слоты
 * пула, не хватило — приходит сколько влезло. Ни один не появился — кольца нет.
 */
export function startCordon(world: World, typeIndex: number, count: number, ring: CordonRingDef): void {
  const state = world.cordon;
  if (state.active) return;

  const offset = randomRingOffset(world.rng);
  const enemies = world.enemies;
  let spawned = 0;
  for (let k = 0; k < count; k++) {
    ringDirection(offset, k, count, direction);
    const slot = spawnOnRing(world, typeIndex, direction.x, direction.y);
    if (slot < 0) break;
    // Место в строю — то самое направление, откуда страж пришёл: он идёт радиально.
    enemies.dirX[slot] = direction.x;
    enemies.dirY[slot] = direction.y;
    enemies.phase[slot] = CORDON_PHASE.arriving;
    spawned++;
  }
  if (spawned === 0) return;

  const scale = world.config.unitScale;
  state.active = true;
  state.centerX = world.player.x;
  state.centerY = world.player.y;
  state.radius = ring.radius * scale;
  state.minRadius = ring.minRadius * scale;
  state.shrinkPerSec = ring.shrinkPerSec * scale;
  state.timeLeftSec = ring.lifeSec;
}

/**
 * Шаг кольца: сжатие, время и конец. Кончается оно, когда живых стражей не
 * осталось или вышло время; по времени стражи исчезают без убийства — без
 * добычи, опыта и счёта (`despawnEnemy`, а не `killEnemy`).
 */
export function updateCordon(world: World, dtSec: number): void {
  const state = world.cordon;
  if (!state.active) return;

  state.radius = Math.max(state.minRadius, state.radius - state.shrinkPerSec * dtSec);
  state.timeLeftSec -= dtSec;

  const enemies = world.enemies;
  let guards = 0;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 1 && world.enemyTypes[enemies.type[i]].anchored) guards++;
  }
  if (guards === 0) {
    state.active = false;
    return;
  }
  if (state.timeLeftSec > 0) return;

  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 1 && world.enemyTypes[enemies.type[i]].anchored) despawnEnemy(world, i);
  }
  state.active = false;
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
