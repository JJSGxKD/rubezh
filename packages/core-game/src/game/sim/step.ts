import { applyPattern, MAX_PATTERN_RADIUS, onEnemyKilled } from "../patterns";
import { vectorLength } from "./vector";
import {
  damagePlayer,
  despawnEnemy,
  NO_OWNER_TYPE,
  spawnProjectile,
  TICK_SEC,
  type World,
} from "./world";

/**
 * Ввод игрока за тик. Нормализуется вызывающим кодом; симуляция принимает
 * направление, а не координаты курсора — так один и тот же скрипт ввода
 * воспроизводится и с джойстика, и из теста (docs/17-testing-strategy.md §3.2).
 */
export interface SimInput {
  moveX: number;
  moveY: number;
}

export const IDLE_INPUT: SimInput = { moveX: 0, moveY: 0 };

/** Интервал контактной атаки врага ближнего боя. */
const MELEE_INTERVAL_SEC = 0.6;
/** Время жизни снаряда игрока — страховка от снарядов, улетевших мимо всех. */
const PLAYER_PROJECTILE_TTL_SEC = 1.6;

/**
 * Один шаг симуляции. Строго фиксированный dt: переменный шаг ломает
 * воспроизводимость, а вместе с ней golden-прогоны и разбор баг-репортов.
 * Накопление реального времени и вызов нужного числа шагов — забота рендера.
 */
export function stepWorld(world: World, input: SimInput): void {
  const dt = TICK_SEC;

  snapshotPositions(world);
  movePlayer(world, input, dt);
  world.enemyGrid.rebuild(world.enemies.x, world.enemies.y, world.enemies.alive, world.enemies.count);
  updateEnemies(world, dt);
  playerAutoAttack(world, input, dt);
  updateProjectiles(world, dt);

  world.stats.tick++;
  world.stats.elapsedSec = world.stats.tick * dt;
}

/**
 * Позиции предыдущего тика сохраняются целиком одним копированием массива:
 * поэлементный цикл здесь ничего не выиграет, а рендеру нужны и «мёртвые»
 * слоты — враг может умереть между тиками, пока кадр ещё не отрисован.
 */
function snapshotPositions(world: World): void {
  world.player.prevX = world.player.x;
  world.player.prevY = world.player.y;
  world.enemies.prevX.set(world.enemies.x);
  world.enemies.prevY.set(world.enemies.y);
  world.projectiles.prevX.set(world.projectiles.x);
  world.projectiles.prevY.set(world.projectiles.y);
}

/**
 * Движение с разгоном и торможением. Раньше скорость переключалась мгновенно,
 * и персонаж дёргался при каждой смене направления — особенно заметно при
 * управлении пальцем, где направление меняется каждый кадр.
 */
function movePlayer(world: World, input: SimInput, dt: number): void {
  const player = world.player;
  if (!player.alive) return;

  const magnitude = vectorLength(input.moveX, input.moveY);
  const speed = world.config.player.speedPxSec;
  const desiredVx = magnitude < 1e-3 ? 0 : (input.moveX / magnitude) * speed;
  const desiredVy = magnitude < 1e-3 ? 0 : (input.moveY / magnitude) * speed;

  const maxDelta = world.config.player.accelerationPxSec2 * dt;
  player.vx += clamp(desiredVx - player.vx, -maxDelta, maxDelta);
  player.vy += clamp(desiredVy - player.vy, -maxDelta, maxDelta);

  const radius = world.config.player.radius;
  const nextX = clamp(player.x + player.vx * dt, radius, world.config.width - radius);
  const nextY = clamp(player.y + player.vy * dt, radius, world.config.height - radius);

  // Упёрлись в край — гасим скорость по этой оси, иначе персонаж «залипает»
  // у стены и не начинает движение обратно, пока не сбросится накопленная
  // скорость.
  if (nextX === player.x && player.vx !== 0) player.vx = 0;
  if (nextY === player.y && player.vy !== 0) player.vy = 0;

  player.x = nextX;
  player.y = nextY;
}

function updateEnemies(world: World, dt: number): void {
  const enemies = world.enemies;
  const player = world.player;
  const playerRadius = world.config.player.radius;

  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 0) continue;

    const typeIndex = enemies.type[i];
    const type = world.enemyTypes[typeIndex];
    applyPattern(type.pattern, world, i, dt);
    // Паттерн мог убрать врага сам — например, подрывник взорвался.
    if (enemies.alive[i] === 0) continue;

    enemies.x[i] += enemies.vx[i] * dt;
    enemies.y[i] += enemies.vy[i] * dt;

    if (!player.alive) continue;

    // Бьёт ли касанием — возможность паттерна, а не проверка его имени: у
    // стрелка таймер занят перезарядкой выстрела, подрывник бьёт взрывом.
    if (!type.contactDamage) continue;

    const dx = player.x - enemies.x[i];
    const dy = player.y - enemies.y[i];
    const contactDistance = type.radius + playerRadius;

    if (enemies.attackCooldown[i] > 0) {
      enemies.attackCooldown[i] -= dt;
      continue;
    }
    if (dx * dx + dy * dy <= contactDistance * contactDistance) {
      damagePlayer(world, type.damage, typeIndex);
      enemies.attackCooldown[i] = MELEE_INTERVAL_SEC;
    }
  }
}

/**
 * Автоатака бьёт по ближайшей цели постоянно, в том числе на бегу.
 * Изначально стрельба работала только на остановке (формулировка роадмапа
 * недели 1), но в связке с бесконечным напором врагов это заставляло стоять
 * под ударом — механика читалась как наказание за движение.
 */
function playerAutoAttack(world: World, _input: SimInput, dt: number): void {
  const player = world.player;
  if (!player.alive) return;

  if (player.attackCooldown > 0) player.attackCooldown -= dt;
  if (player.attackCooldown > 0) return;

  const target = findNearestEnemy(world, player.x, player.y, world.config.player.attackRangePx);
  if (target < 0) return;

  const dx = world.enemies.x[target] - player.x;
  const dy = world.enemies.y[target] - player.y;
  const distance = vectorLength(dx, dy);
  if (distance < 1e-3) return;

  const speed = world.config.player.projectileSpeedPxSec;
  spawnProjectile(
    world,
    player.x,
    player.y,
    (dx / distance) * speed,
    (dy / distance) * speed,
    world.config.player.attackDamage,
    PLAYER_PROJECTILE_TTL_SEC,
    true,
  );
  player.attackCooldown = world.config.player.attackCooldownSec;
  world.stats.shotsFired++;
}

function findNearestEnemy(world: World, x: number, y: number, radius: number): number {
  const found = world.enemyGrid.queryInto(x, y, radius, world.queryBuffer);
  const enemies = world.enemies;

  let best = -1;
  let bestDistanceSq = radius * radius;
  for (let k = 0; k < found; k++) {
    const i = world.queryBuffer[k];
    if (enemies.alive[i] === 0) continue;
    const dx = enemies.x[i] - x;
    const dy = enemies.y[i] - y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = i;
    }
  }
  return best;
}

function updateProjectiles(world: World, dt: number): void {
  const projectiles = world.projectiles;
  const enemies = world.enemies;
  const player = world.player;
  const playerRadius = world.config.player.radius;
  const projectileRadius = world.config.player.projectileRadius;

  for (let p = 0; p < projectiles.count; p++) {
    if (projectiles.alive[p] === 0) continue;

    projectiles.ttl[p] -= dt;
    projectiles.x[p] += projectiles.vx[p] * dt;
    projectiles.y[p] += projectiles.vy[p] * dt;

    if (projectiles.ttl[p] <= 0 || isOutside(world, projectiles.x[p], projectiles.y[p])) {
      killProjectile(world, p);
      continue;
    }

    if (projectiles.fromPlayer[p] === 1) {
      const hit = findHitEnemy(world, projectiles.x[p], projectiles.y[p], projectileRadius);
      if (hit >= 0) {
        enemies.hp[hit] -= projectiles.damage[p];
        if (enemies.hp[hit] <= 0) killEnemy(world, hit);
        killProjectile(world, p);
      }
      continue;
    }

    if (!player.alive) continue;
    const dx = player.x - projectiles.x[p];
    const dy = player.y - projectiles.y[p];
    const contact = playerRadius + projectileRadius;
    if (dx * dx + dy * dy <= contact * contact) {
      const owner = projectiles.ownerType[p];
      damagePlayer(world, projectiles.damage[p], owner === NO_OWNER_TYPE ? -1 : owner);
      killProjectile(world, p);
    }
  }
}

function findHitEnemy(world: World, x: number, y: number, projectileRadius: number): number {
  const found = world.enemyGrid.queryInto(
    x,
    y,
    projectileRadius + MAX_PATTERN_RADIUS * world.config.unitScale,
    world.queryBuffer,
  );
  const enemies = world.enemies;

  for (let k = 0; k < found; k++) {
    const i = world.queryBuffer[k];
    if (enemies.alive[i] === 0) continue;
    const contact = world.enemyTypes[enemies.type[i]].radius + projectileRadius;
    const dx = enemies.x[i] - x;
    const dy = enemies.y[i] - y;
    if (dx * dx + dy * dy <= contact * contact) return i;
  }
  return -1;
}

function isOutside(world: World, x: number, y: number): boolean {
  // Запас за краем экрана: враги спавнятся снаружи и не должны считаться
  // «улетевшими» вместе со снарядами, которые в них летят.
  const margin = 64 * world.config.unitScale;
  return x < -margin || y < -margin || x > world.config.width + margin || y > world.config.height + margin;
}

/**
 * Убийство врага игроком: счётчики, освобождение слота и реакция паттерна —
 * именно в этом порядке. Слот освобождается до реакции, чтобы делящийся враг
 * мог поставить потомка на своё место при почти полном пуле.
 */
function killEnemy(world: World, index: number): void {
  const typeIndex = world.enemies.type[index];
  world.stats.enemiesKilled++;
  world.stats.killsByType[typeIndex]++;
  despawnEnemy(world, index);
  onEnemyKilled(world.enemyTypes[typeIndex].pattern, world, index);
}

function killProjectile(world: World, index: number): void {
  world.projectiles.alive[index] = 0;
  world.projectiles.aliveCount--;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
