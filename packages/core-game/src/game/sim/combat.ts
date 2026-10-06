import { isElite, onEnemyKilled } from "../patterns";
import { dropGems } from "./gems";
import { rollPickups } from "./pickups";
import { stageOf } from "./stages";
import { CHAIN_SHARE, chainTargets, damageMultiplier, ELEMENT_LIGHTNING, ELEMENT_PHYSICAL, tryApplyStatus } from "./elements";
import { despawnEnemy, NO_OWNER_TYPE, type World } from "./world";

/**
 * Урон врагу — одна точка входа для всего оружия и для снарядов.
 *
 * Стихия умножает урон на сопротивление типа врага и на шок, а после
 * попадания пробует наложить своё состояние (`sim/elements.ts`). Физический
 * урон с нулевым шансом идёт прежним путём и генератор не трогает.
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
  element: number = ELEMENT_PHYSICAL,
  statusChance = 0,
): void {
  if (world.enemies.alive[index] === 0 || amount <= 0) return;
  // Шок проверяется до удара: перескакивает молния, которая пришла в уже
  // шокированного, а не та, что шок только что наложила.
  const chains = element === ELEMENT_LIGHTNING && world.enemies.shockTimer[index] > 0;
  const multiplied = amount * damageMultiplier(world, index, element);
  const applied = inflictDamage(world, index, multiplied, weaponSlot, element);
  if (world.enemies.alive[index] === 1) tryApplyStatus(world, index, element, statusChance, applied, weaponSlot);
  if (!chains) return;

  // Цели ищутся от места удара — и тогда, когда удар добил врага: его
  // координаты в слоте ещё целы.
  const count = chainTargets(world, index, chainScratch);
  for (let k = 0; k < count; k++) {
    const target = chainScratch[k] ?? -1;
    inflictDamage(world, target, amount * CHAIN_SHARE * damageMultiplier(world, target, ELEMENT_LIGHTNING), weaponSlot, ELEMENT_LIGHTNING);
  }
}

/** Цели перескока — два индекса; массив на модуль, без аллокаций на удар. */
const chainScratch = new Int32Array(2);

/**
 * Урон без стихийных множителей — им бьют и попадания, и урон по времени:
 * горение и яд уже посчитаны от урона с сопротивлением, второй раз его
 * применять нельзя. Возвращает нанесённый урон.
 */
export function inflictDamage(
  world: World,
  index: number,
  amount: number,
  weaponSlot: number,
  element: number = ELEMENT_PHYSICAL,
): number {
  const enemies = world.enemies;
  if (enemies.alive[index] === 0 || amount <= 0) return 0;

  const cheats = world.cheats;
  const dealt = cheats.oneHitKill ? enemies.hp[index] : amount * cheats.damageMul;
  // В статистику идёт нанесённый урон, а не заявленный: добивание на единицу
  // здоровья не должно выглядеть как полный удар.
  const applied = Math.min(dealt, enemies.hp[index]);
  enemies.hp[index] -= dealt;
  enemies.hitTick[index] = world.stats.tick;
  world.stats.damageDealt += applied;
  world.stats.damageByElement[element] += applied;
  if (weaponSlot !== NO_OWNER_TYPE && weaponSlot < world.stats.damageByWeapon.length) {
    world.stats.damageByWeapon[weaponSlot] += applied;
  }

  if (enemies.hp[index] > 0) return applied;
  killEnemy(world, index);
  return applied;
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
    rollPickups(world, x, y, isElite(type));
  }
  onEnemyKilled(type.pattern, world, index);
}
