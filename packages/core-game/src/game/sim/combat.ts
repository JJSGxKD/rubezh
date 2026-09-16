import { onEnemyKilled } from "../patterns";
import { dropGems } from "./gems";
import { rollPickups } from "./pickups";
import { stageOf } from "./stages";
import { despawnEnemy, NO_OWNER_TYPE, type World } from "./world";

/**
 * Урон врагу — одна точка входа для всего оружия и для снарядов.
 *
 * Здесь же живут последствия смерти: счётчики, выпадение опыта и реакция
 * паттерна (распад делящегося). Раньше это лежало в шаге симуляции и было
 * доступно только снарядам; теперь бьют ещё аура, орбита и удар по площади.
 *
 * `weaponSlot` — номер оружия в наборе для статистики урона по оружиям;
 * `NO_OWNER_TYPE`, если урон нанесло не оружие игрока.
 */
export function damageEnemy(
  world: World,
  index: number,
  amount: number,
  weaponSlot: number,
): void {
  const enemies = world.enemies;
  if (enemies.alive[index] === 0 || amount <= 0) return;

  const cheats = world.cheats;
  const dealt = cheats.oneHitKill ? enemies.hp[index] : amount * cheats.damageMul;
  // В статистику идёт нанесённый урон, а не заявленный: добивание на единицу
  // здоровья не должно выглядеть как полный удар.
  const applied = Math.min(dealt, enemies.hp[index]);
  enemies.hp[index] -= dealt;
  enemies.hitTick[index] = world.stats.tick;
  world.stats.damageDealt += applied;
  if (weaponSlot !== NO_OWNER_TYPE && weaponSlot < world.stats.damageByWeapon.length) {
    world.stats.damageByWeapon[weaponSlot] += applied;
  }

  if (enemies.hp[index] > 0) return;
  killEnemy(world, index);
}

/**
 * Убийство врага игроком: счётчики, кристалл опыта, освобождение слота и
 * реакция паттерна — в этом порядке. Слот освобождается до реакции, чтобы
 * делящийся враг мог поставить потомка на своё место при почти полном пуле.
 */
export function killEnemy(world: World, index: number): void {
  const typeIndex = world.enemies.type[index];
  const type = world.enemyTypes[typeIndex];
  const stage = stageOf(world, index);

  world.stats.enemiesKilled++;
  world.stats.killsByType[typeIndex]++;

  const x = world.enemies.x[index];
  const y = world.enemies.y[index];
  despawnEnemy(world, index);

  if (world.config.lootEnabled) {
    // Опыт по ступени: матёрый враг дороже стоит и лучше качает, иначе его
    // незачем убивать — выгоднее убежать к обычным.
    dropGems(world, x, y, Math.round(type.xp * stage.xpMul));
    rollPickups(world, x, y, type.elite);
  }
  onEnemyKilled(type.pattern, world, index);
}
