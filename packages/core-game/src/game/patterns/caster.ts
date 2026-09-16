import { spawnProjectile, type World } from "../sim/world";
import { createDirection, randomRingOffset, ringDirection } from "../sim/directions";
import { vectorLength } from "../sim/vector";
import { bossPhaseOf } from "../run/boss";
import type { PatternBehavior } from "./behavior";
import { createHeading, enemySpeed, headingToPlayer, MIN_HEADING_DISTANCE, stopEnemy } from "./steering";

export const CASTER_PHASE = {
  /** держит дистанцию и копит следующий каст */
  hold: 0,
  /** стоит, светится и вот-вот ударит — время игрока на реакцию */
  windup: 1,
} as const;

/** Сколько живут снаряды каста: дольше обычных, чтобы стена успевала дойти. */
const PROJECTILE_TTL_SEC = 6;

/** Разброс веера — тот же шаг, что у оружия игрока: поле читается одинаково. */
const SPREAD_STEP = 0.2;

/** Мёртвая зона у желаемой дистанции, иначе кастер дрожит на месте. */
const DEADZONE_UNITS = 30;

/** Доля скорости снаряда у «стены»: она ползёт, её обходят, а не уворачиваются. */
const WALL_SPEED_RATIO = 0.55;

/** Насколько чаще кастер бьёт в следующей фазе боя. */
const PHASE_SPEEDUP = 0.72;

const heading = createHeading();
const direction = createDirection();

/**
 * Кастует по площади, держась в стороне от игрока.
 *
 * Три заклинания — кольцо, веер и ползущая стена, — и какое пойдёт следующим,
 * не угадать: рисунок боя не заучивается наизусть. Чем меньше у босса
 * здоровья, тем чаще и гуще каст: фаза боя одна и та же и для полосы на
 * экране, и для поведения (`game/run/boss.ts`), поэтому игрок связывает
 * «полоса дошла до деления» и «он озверел» сам.
 *
 * Перед каждым кастом босс замирает и светится — это время игрока уйти с
 * линии. Без этого случайность заклинаний превращается в случайность урона.
 */
export const caster: PatternBehavior = {
  update(world, index, dtSec) {
    const enemies = world.enemies;
    const type = world.enemyTypes[enemies.type[index]];

    if (enemies.phase[index] === CASTER_PHASE.windup) {
      stopEnemy(world, index);
      enemies.phaseTimer[index] -= dtSec;
      if (enemies.phaseTimer[index] > 0) return;

      cast(world, index);
      enemies.phase[index] = CASTER_PHASE.hold;
      enemies.attackCooldown[index] = type.params.castIntervalSec * speedup(world, index);
      return;
    }

    keepDistance(world, index, type.params.preferredDistance);

    enemies.attackCooldown[index] -= dtSec;
    if (enemies.attackCooldown[index] > 0) return;

    // Замирает тем же тиком, когда начал копить: иначе первый кадр телеграфа
    // он ещё едет, и «стоит и светится» перестаёт быть правилом.
    stopEnemy(world, index);
    enemies.phase[index] = CASTER_PHASE.windup;
    enemies.phaseTimer[index] = type.params.telegraphSec;
  },
};

/** Во сколько раз короче пауза между кастами в текущей фазе боя. */
function speedup(world: World, index: number): number {
  let ratio = 1;
  for (let phase = 0; phase < bossPhaseOf(world, index); phase++) ratio *= PHASE_SPEEDUP;
  return ratio;
}

function keepDistance(world: World, index: number, preferred: number): void {
  const enemies = world.enemies;
  headingToPlayer(world, index, heading);
  if (heading.distance < MIN_HEADING_DISTANCE) return;

  const deadzone = DEADZONE_UNITS * world.config.unitScale;
  const speed = enemySpeed(world, index);
  if (heading.distance > preferred + deadzone) {
    enemies.vx[index] = heading.nx * speed;
    enemies.vy[index] = heading.ny * speed;
  } else if (heading.distance < preferred - deadzone) {
    enemies.vx[index] = -heading.nx * speed;
    enemies.vy[index] = -heading.ny * speed;
  } else {
    stopEnemy(world, index);
  }
}

function cast(world: World, index: number): void {
  const phase = bossPhaseOf(world, index);
  // В последней фазе идут два заклинания подряд: добивающий босс обязан
  // ощущаться иначе, чем тот же босс в начале боя.
  const spells = phase >= 2 ? 2 : 1;
  for (let n = 0; n < spells; n++) {
    switch (world.rng.nextInt(0, 3)) {
      case 0:
        castRing(world, index, phase);
        break;
      case 1:
        castFan(world, index, phase);
        break;
      default:
        castWall(world, index, phase);
    }
  }
}

/** Кольцо шаров во все стороны: уйти можно только в промежуток между ними. */
function castRing(world: World, index: number, phase: number): void {
  const enemies = world.enemies;
  const type = world.enemyTypes[enemies.type[index]];
  const count = type.params.burstCount + phase * 3;
  const offset = randomRingOffset(world.rng);

  for (let step = 0; step < count; step++) {
    ringDirection(offset, step, count, direction);
    fire(world, index, direction.x, direction.y, type.params.projectileSpeed);
  }
}

/** Веер в игрока: бьёт туда, где он стоит, и наказывает бег по прямой. */
function castFan(world: World, index: number, phase: number): void {
  const enemies = world.enemies;
  const type = world.enemyTypes[enemies.type[index]];
  headingToPlayer(world, index, heading);
  if (heading.distance < MIN_HEADING_DISTANCE) return;

  const count = Math.max(3, Math.round(type.params.burstCount / 2) + phase);
  for (let i = 0; i < count; i++) {
    // 0, +1, −1, +2, −2 — центр занят всегда, как в веере оружия игрока.
    const step = i === 0 ? 0 : Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
    const offset = step * SPREAD_STEP;
    const x = heading.nx - heading.ny * offset;
    const y = heading.ny + heading.nx * offset;
    const length = vectorLength(x, y);
    if (length < 1e-6) continue;
    fire(world, index, x / length, y / length, type.params.projectileSpeed);
  }
}

/**
 * Ползущая стена поперёк направления на игрока: медленная и широкая. От неё
 * не уворачиваются рывком — её обходят, и это единственное заклинание, которое
 * заставляет двигаться заранее.
 */
function castWall(world: World, index: number, phase: number): void {
  const enemies = world.enemies;
  const type = world.enemyTypes[enemies.type[index]];
  headingToPlayer(world, index, heading);
  if (heading.distance < MIN_HEADING_DISTANCE) return;

  const count = type.params.burstCount + phase * 2;
  const gap = type.radius * 1.6;
  const speed = type.params.projectileSpeed * WALL_SPEED_RATIO;

  for (let i = 0; i < count; i++) {
    const step = i - (count - 1) / 2;
    const x = enemies.x[index] - heading.ny * gap * step;
    const y = enemies.y[index] + heading.nx * gap * step;
    spawn(world, index, x, y, heading.nx * speed, heading.ny * speed);
  }
}

function fire(world: World, index: number, dirX: number, dirY: number, speed: number): void {
  const enemies = world.enemies;
  spawn(world, index, enemies.x[index], enemies.y[index], dirX * speed, dirY * speed);
}

function spawn(world: World, index: number, x: number, y: number, vx: number, vy: number): void {
  const enemies = world.enemies;
  const slot = spawnProjectile(
    world,
    x,
    y,
    vx,
    vy,
    // Урон из слота, а не из типа: в нём застыли множители отрезка и ступени.
    enemies.damage[index],
    PROJECTILE_TTL_SEC,
    false,
  );
  if (slot >= 0) world.projectiles.ownerType[slot] = enemies.type[index];
}
