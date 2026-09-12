import { applyPattern, MAX_PATTERN_RADIUS } from "../patterns";
import { isAwaitingChoice, prepareOffers } from "../progression/levels";
import { updateWeapons } from "../weapons";
import { damageEnemy } from "./combat";
import { updateGems } from "./gems";
import { vectorLength } from "./vector";
import { damagePlayer, NO_OWNER_TYPE, TICK_SEC, type World } from "./world";

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

/**
 * Один шаг симуляции. Строго фиксированный dt: переменный шаг ломает
 * воспроизводимость, а вместе с ней golden-прогоны и разбор баг-репортов.
 * Накопление реального времени и вызов нужного числа шагов — забота рендера.
 *
 * Пока игрок выбирает улучшение, мир стоит: шаг не делается вовсе. Так пауза
 * получается детерминированной — в логе ввода выбор приходит на конкретный
 * тик, и повтор забега попадает в тот же момент (docs/26-stage2-plan.md, WP2).
 */
export function stepWorld(world: World, input: SimInput): void {
  const dt = TICK_SEC;
  if (isAwaitingChoice(world)) return;

  snapshotPositions(world);
  movePlayer(world, input, dt);
  regeneratePlayer(world, dt);
  world.enemyGrid.rebuild(world.enemies.x, world.enemies.y, world.enemies.alive, world.enemies.count);
  updateEnemies(world, dt);
  updateWeapons(world, dt);
  updateProjectiles(world, dt);

  if (world.config.progressionEnabled) {
    updateGems(world, dt);
    // Варианты готовятся в конце шага: игрок увидит их на следующем кадре, а
    // мир к этому моменту уже в согласованном состоянии.
    prepareOffers(world);
  }

  world.stats.tick++;
  world.stats.elapsedSec = world.stats.tick * dt;
  // Пик считается в конце шага: спавн отрабатывает до него, значит сюда
  // попадает та самая толпа, которую игрок видел на экране.
  if (world.enemies.aliveCount > world.stats.peakEnemies) {
    world.stats.peakEnemies = world.enemies.aliveCount;
  }
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
  const speed = world.config.player.speedPxSec * world.playerStats.moveSpeedMul;
  const desiredVx = magnitude < 1e-3 ? 0 : (input.moveX / magnitude) * speed;
  const desiredVy = magnitude < 1e-3 ? 0 : (input.moveY / magnitude) * speed;

  // Направление взгляда запоминается только при движении: на остановке
  // оружие, бьющее по направлению, должно смотреть туда же, куда игрок шёл.
  if (magnitude >= 1e-3) {
    player.faceX = input.moveX / magnitude;
    player.faceY = input.moveY / magnitude;
  }

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

  // Расстояние берётся по факту перемещения, а не по скорости: у стены
  // скорость есть, а движения нет, и километраж бы врал.
  world.stats.distance += vectorLength(nextX - player.x, nextY - player.y);

  player.x = nextX;
  player.y = nextY;
}

function regeneratePlayer(world: World, dt: number): void {
  const regen = world.playerStats.regenPerSec;
  const player = world.player;
  if (regen <= 0 || !player.alive) return;

  player.hp = Math.min(world.playerStats.maxHp, player.hp + regen * dt);
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

function updateProjectiles(world: World, dt: number): void {
  const projectiles = world.projectiles;
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
      hitEnemies(world, p, projectileRadius);
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

/**
 * Попадание снаряда игрока. Пробивающий снаряд летит дальше, но по одному и
 * тому же врагу не бьёт дважды подряд: перекрытие длится несколько тиков, и
 * без отметки последнего задетого весь запас пробивания уходил бы в одного.
 */
function hitEnemies(world: World, p: number, projectileRadius: number): void {
  const projectiles = world.projectiles;
  const hit = findHitEnemy(world, projectiles.x[p], projectiles.y[p], projectileRadius, projectiles.lastHit[p]);
  if (hit < 0) return;

  damageEnemy(world, hit, projectiles.damage[p], projectiles.ownerWeapon[p]);
  projectiles.lastHit[p] = hit;

  if (projectiles.pierce[p] > 0) {
    projectiles.pierce[p]--;
    return;
  }
  killProjectile(world, p);
}

function findHitEnemy(
  world: World,
  x: number,
  y: number,
  projectileRadius: number,
  exclude: number,
): number {
  const found = world.enemyGrid.queryInto(
    x,
    y,
    projectileRadius + MAX_PATTERN_RADIUS * world.config.unitScale,
    world.queryBuffer,
  );
  const enemies = world.enemies;

  for (let k = 0; k < found; k++) {
    const i = world.queryBuffer[k];
    if (enemies.alive[i] === 0 || i === exclude) continue;
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

function killProjectile(world: World, index: number): void {
  world.projectiles.alive[index] = 0;
  world.projectiles.aliveCount--;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
