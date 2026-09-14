import type { RunDevCommand } from "../../run-api";
import { addXp, prepareOffers, refreshPlayerStats } from "../progression/levels";
import { addPassive, addWeapon, passiveSlotOf, weaponSlotOf } from "../progression/loadout";
import { killEnemy } from "../sim/combat";
import { createDirection, ringDirection } from "../sim/directions";
import { spawnGem } from "../sim/gems";
import { PICKUP_KIND, spawnPickup } from "../sim/pickups";
import { clampToBounds, despawnEnemy, spawnEnemy, TICK_SEC, type World } from "../sim/world";

/**
 * Разовые действия режима разработчика (docs/26-stage2-plan.md, WP14). Каждое
 * применяется на границе тика — между кадрами, когда шаг симуляции не идёт:
 * мир остаётся согласованным, и после команды забег продолжается как обычно.
 *
 * Лимиты слотов здесь не соблюдаются: проверить пятое оружие рядом с
 * четырьмя — ровно то, зачем разработчику эта команда.
 */

/** На каком расстоянии от игрока появляется заспавненное — в игровых единицах. */
const SPAWN_DISTANCE_UNITS = 220;
const PICKUP_DISTANCE_UNITS = 140;
const MAX_SPAWN_COUNT = 200;
const MAX_JUMP_MINUTE = 120;

const direction = createDirection();

/** Результат команды: применена ли она и нужно ли сцене показать выбор улучшения. */
export interface DevCommandOutcome {
  applied: boolean;
  /** команда меняет исход забега — забег помечается как с читами */
  cheat: boolean;
}

export function applyDevCommand(world: World, command: RunDevCommand): DevCommandOutcome {
  switch (command.kind) {
    case "levelUp":
      return cheat(levelUp(world, command.count));
    case "giveWeapon":
      return cheat(giveWeapon(world, command.id, command.level));
    case "givePassive":
      return cheat(givePassive(world, command.id, command.level));
    case "spawnEnemy":
      return cheat(spawnEnemiesNear(world, command.id, command.count));
    case "spawnPickup":
      return cheat(spawnPickupNear(world, command.pickup));
    case "spawnGems":
      return cheat(spawnGemsNear(world, command.value, command.count));
    case "killAll":
      return cheat(killAll(world));
    case "heal":
      world.player.hp = world.playerStats.maxHp;
      return cheat(true);
    case "jumpToMinute":
      return cheat(jumpToMinute(world, command.minute));
    case "stepTicks":
      // Шаг исполняет сцена: ей нужен спавнер и рендер, а миру — только ввод.
      return { applied: false, cheat: false };
  }
}

function cheat(applied: boolean): DevCommandOutcome {
  return { applied, cheat: applied };
}

function levelUp(world: World, count: number): boolean {
  const levels = clampInt(count, 1, 50);
  for (let i = 0; i < levels; i++) addXp(world, world.progression.xpToNext - world.progression.xp);
  // Варианты готовятся сразу: на паузе шаг не идёт, а выбор должен открыться
  // по нажатию, а не после «Продолжить».
  prepareOffers(world);
  return true;
}

function giveWeapon(world: World, id: string, level: number): boolean {
  const typeIndex = world.weaponTypes.findIndex((type) => type.id === id);
  const type = world.weaponTypes[typeIndex];
  if (type === undefined) return false;
  const existing = weaponSlotOf(world.loadout, typeIndex);
  const slot = existing >= 0 ? world.loadout.weapons[existing] : addWeapon(world.loadout, typeIndex);
  if (slot === undefined) return false;
  slot.level = clampInt(level, 1, type.levels.length);
  ensureWeaponStats(world);
  return true;
}

function givePassive(world: World, id: string, level: number): boolean {
  const typeIndex = world.passiveTypes.findIndex((type) => type.id === id);
  const type = world.passiveTypes[typeIndex];
  if (type === undefined) return false;
  const existing = passiveSlotOf(world.loadout, typeIndex);
  const slot = existing >= 0 ? world.loadout.passives[existing] : addPassive(world.loadout, typeIndex);
  if (slot === undefined) return false;
  slot.level = clampInt(level, 1, type.levels.length);
  refreshPlayerStats(world);
  return true;
}

/**
 * Урон по оружию считается в массиве по числу слотов из контента. Оружие сверх
 * лимита иначе било бы, но в «Характеристиках» показывало ноль.
 */
function ensureWeaponStats(world: World): void {
  const needed = world.loadout.weapons.length;
  const current = world.stats.damageByWeapon;
  if (current.length >= needed) return;
  const grown = new Float64Array(needed);
  grown.set(current);
  world.stats.damageByWeapon = grown;
}

/** Кольцом вокруг игрока: так видно, как тип подходит с разных сторон. */
function spawnEnemiesNear(world: World, id: string, count: number): boolean {
  const typeIndex = world.enemyTypes.findIndex((type) => type.id === id);
  if (typeIndex < 0) return false;
  const total = clampInt(count, 1, MAX_SPAWN_COUNT);
  const distance = SPAWN_DISTANCE_UNITS * world.config.unitScale;
  const bounds = world.config.bounds;
  const radius = world.enemyTypes[typeIndex]?.radius ?? 0;
  let spawned = 0;
  for (let i = 0; i < total; i++) {
    ringDirection(0, i, total, direction);
    const x = clampToBounds(world.player.x + direction.x * distance, bounds.halfWidth - radius);
    const y = clampToBounds(world.player.y + direction.y * distance, bounds.halfHeight - radius);
    if (spawnEnemy(world, typeIndex, x, y) >= 0) spawned++;
  }
  return spawned > 0;
}

function spawnPickupNear(world: World, pickup: keyof typeof PICKUP_KIND): boolean {
  // За радиусом подбора, каким бы его ни сделали пассивки, но в паре шагов.
  const distance = Math.max(PICKUP_DISTANCE_UNITS * world.config.unitScale, world.playerStats.pickupRadius * 1.5);
  // Справа от взгляда, а не под ногами: подбор под игроком собрался бы в тот
  // же тик, и проверить, как он выглядит на земле, было бы нельзя.
  const x = world.player.x - world.player.faceY * distance;
  const y = world.player.y + world.player.faceX * distance;
  return spawnPickup(world, PICKUP_KIND[pickup], x, y);
}

function spawnGemsNear(world: World, value: number, count: number): boolean {
  const total = clampInt(count, 1, MAX_SPAWN_COUNT);
  const distance = PICKUP_DISTANCE_UNITS * 2 * world.config.unitScale;
  for (let i = 0; i < total; i++) {
    ringDirection(0, i, total, direction);
    spawnGem(world, world.player.x + direction.x * distance, world.player.y + direction.y * distance, clampInt(value, 1, 10_000));
  }
  return true;
}

/** Элиту тоже: команда — «очистить поле», а не «пропустить контрольную точку по правилам динамита». */
function killAll(world: World): boolean {
  const enemies = world.enemies;
  let killed = 0;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 0) continue;
    killEnemy(world, i);
    killed++;
  }
  return killed > 0;
}

/**
 * Перемотать часы забега. Директор спавна сам догонит таймлайн — по
 * нескольку отрезков за тик, с их выбросами и событиями. Поле перед этим
 * очищается без добычи: иначе к толпе новой минуты добавилась бы вся старая.
 */
function jumpToMinute(world: World, minute: number): boolean {
  const target = clampInt(minute, 0, MAX_JUMP_MINUTE);
  const tick = Math.round((target * 60) / TICK_SEC);
  if (tick <= world.stats.tick) return false;
  const enemies = world.enemies;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.alive[i] === 1) despawnEnemy(world, i);
  }
  world.stats.tick = tick;
  world.stats.elapsedSec = tick * TICK_SEC;
  return true;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const rounded = Math.round(value);
  return rounded < min ? min : rounded > max ? max : rounded;
}
