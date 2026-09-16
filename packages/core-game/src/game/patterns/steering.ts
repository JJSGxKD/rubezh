import type { World } from "../sim/world";
import { stageOf } from "../sim/stages";
import { vectorLength } from "../sim/vector";

/**
 * Скорость врага с учётом его ступени. Читается всеми паттернами: ступень
 * прибавляет к скорости немного, но заметно — матёрый догоняет там, где
 * обычный отставал (content/stages.ts).
 */
export function enemySpeed(world: World, index: number): number {
  return world.enemyTypes[world.enemies.type[index]].speed * stageOf(world, index).speedMul;
}

/** Ниже этой дистанции направление на игрока не определено. */
export const MIN_HEADING_DISTANCE = 1e-3;

/**
 * Направление и расстояние от врага до игрока.
 *
 * Результат пишется в переданный объект, а не возвращается новым: функция
 * зовётся на каждого врага каждый тик, и возврат объекта — это сотни
 * аллокаций в кадр. Каждый паттерн держит свой объект на уровне модуля.
 */
export interface Heading {
  nx: number;
  ny: number;
  distance: number;
}

export function createHeading(): Heading {
  return { nx: 0, ny: 0, distance: 0 };
}

export function headingToPlayer(world: World, index: number, out: Heading): void {
  const dx = world.player.x - world.enemies.x[index];
  const dy = world.player.y - world.enemies.y[index];
  const distance = vectorLength(dx, dy);

  out.distance = distance;
  if (distance < MIN_HEADING_DISTANCE) {
    out.nx = 0;
    out.ny = 0;
    return;
  }
  out.nx = dx / distance;
  out.ny = dy / distance;
}

export function stopEnemy(world: World, index: number): void {
  world.enemies.vx[index] = 0;
  world.enemies.vy[index] = 0;
}

/** Идти на игрока по прямой на полной скорости. */
export function moveStraightToPlayer(world: World, index: number, heading: Heading): void {
  const speed = enemySpeed(world, index);
  headingToPlayer(world, index, heading);
  world.enemies.vx[index] = heading.nx * speed;
  world.enemies.vy[index] = heading.ny * speed;
}

/**
 * Преследование с инерцией: скорость доворачивается к направлению на игрока
 * не мгновенно. Инерция — единственное, что отличает преследование от роя на
 * глаз, без неё оба выглядят одинаково.
 */
export function steerTowardPlayer(
  world: World,
  index: number,
  dtSec: number,
  heading: Heading,
): void {
  const type = world.enemyTypes[world.enemies.type[index]];
  headingToPlayer(world, index, heading);
  if (heading.distance < MIN_HEADING_DISTANCE) return;

  const steering = Math.min(1, type.params.steeringPerSec * dtSec);
  const speed = enemySpeed(world, index);
  const enemies = world.enemies;
  enemies.vx[index] += (heading.nx * speed - enemies.vx[index]) * steering;
  enemies.vy[index] += (heading.ny * speed - enemies.vy[index]) * steering;
}
