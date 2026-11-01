import { PASSIVE_CATEGORIES } from "@bh/shared-types";
import type { World } from "../sim/world";

/**
 * Собран ли набор целиком: заняты все слоты оружия и по всем слотам каждой
 * категории навыков, и всё взятое прокачано до последнего уровня (T-0193, Р127).
 * Этим меряется длина прокачки: пока набор не собран, уровень забега ещё что-то
 * даёт, а после — выбирать нечего.
 *
 * Границы слотов берутся из мира, а не из глобального `LOADOUT_LIMITS`: на
 * низком уровне аккаунта слотов меньше, и набор собирается раньше. Эволюция
 * оружия имеет один уровень и потому считается собранной сразу, как только
 * лежит в слоте.
 *
 * Вызывается раз в тик, пока набор не собран: слотов не больше десяти, цена
 * ничтожна, и выделений памяти здесь нет.
 */
export function isBuildComplete(world: World): boolean {
  const loadout = world.loadout;
  const limits = world.loadoutLimits;

  if (loadout.weapons.length < limits.weapons) return false;
  for (const slot of loadout.weapons) {
    if (slot.level < world.weaponTypes[slot.typeIndex].levels.length) return false;
  }

  for (const category of PASSIVE_CATEGORIES) {
    let taken = 0;
    for (const slot of loadout.passives) {
      const type = world.passiveTypes[slot.typeIndex];
      if (type.category !== category) continue;
      if (slot.level < type.levels.length) return false;
      taken++;
    }
    if (taken < limits.passives[category]) return false;
  }
  return true;
}
