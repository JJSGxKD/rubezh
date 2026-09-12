import type { World } from "../sim/world";
import type { ResolvedWeaponLevel } from "./weapon-types";

/**
 * Контракт поведения оружия.
 *
 * `update` вызывается каждый тик для каждого оружия в наборе игрока. Числа
 * приходят уже с учётом пассивок: поведение не знает ни про пассивки, ни про
 * уровни — только про свои параметры на этот тик.
 *
 * `slot` — номер оружия в наборе; по нему лежит состояние в `loadout`
 * (таймер перезарядки, направление орбиты). Состояние в замыканиях держать
 * нельзя: забег обязан воспроизводиться по seed'у и логу ввода.
 */
export interface WeaponBehaviorImpl {
  update(world: World, slot: number, level: ResolvedWeaponLevel, dtSec: number): void;
}
