/**
 * Набор игрока: какое оружие и какие пассивки собраны за забег и на каком они
 * уровне. Состояние лежит здесь, а не в замыканиях поведений: забег обязан
 * воспроизводиться по seed'у и логу ввода, а значит всё состояние должно быть
 * частью мира.
 */
export interface WeaponSlot {
  typeIndex: number;
  level: number;
  /** до следующего срабатывания, секунды */
  cooldown: number;
  /**
   * Направление первого орбитера — единичный вектор, который доворачивается
   * каждый тик. Углы не хранятся: тригонометрия расходится между JS-движками
   * (docs/26-stage2-plan.md, WP4.5).
   */
  dirX: number;
  dirY: number;
}

export interface PassiveSlot {
  typeIndex: number;
  level: number;
}

export interface LoadoutState {
  weapons: WeaponSlot[];
  passives: PassiveSlot[];
}

export function createLoadout(): LoadoutState {
  return { weapons: [], passives: [] };
}

export function weaponSlotOf(loadout: LoadoutState, typeIndex: number): number {
  return loadout.weapons.findIndex((slot) => slot.typeIndex === typeIndex);
}

export function passiveSlotOf(loadout: LoadoutState, typeIndex: number): number {
  return loadout.passives.findIndex((slot) => slot.typeIndex === typeIndex);
}

export function addWeapon(loadout: LoadoutState, typeIndex: number): WeaponSlot {
  const slot: WeaponSlot = { typeIndex, level: 1, cooldown: 0, dirX: 1, dirY: 0 };
  loadout.weapons.push(slot);
  return slot;
}

export function addPassive(loadout: LoadoutState, typeIndex: number): PassiveSlot {
  const slot: PassiveSlot = { typeIndex, level: 1 };
  loadout.passives.push(slot);
  return slot;
}

/** Уровни пассивок по индексу типа — вход для пересчёта характеристик. */
export function passiveLevels(loadout: LoadoutState): Map<number, number> {
  const levels = new Map<number, number>();
  for (const slot of loadout.passives) levels.set(slot.typeIndex, slot.level);
  return levels;
}
