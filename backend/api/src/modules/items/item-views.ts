import { INVENTORY_CAP, ITEM_RARITIES, type ItemRarity, type ItemSlot, type ItemStat } from "./item-catalog.js";
import { itemPower, levelCap, mergeCost, rerollCost, salvageYield, statValue, upgradeCost, type ItemCost, type ItemShape } from "./item-rules.js";
import type { ItemRow } from "./items.repository.js";

/**
 * Предмет глазами клиента: значения уже посчитаны, цены — тоже. Клиент не
 * знает правил снаряжения и не должен их повторять: иначе число на экране и
 * число в забеге однажды разошлись бы.
 */
export interface ItemView {
  itemId: string;
  slot: ItemSlot;
  rarity: ItemRarity;
  level: number;
  equipped: boolean;
  power: number;
  main: { stat: ItemStat; value: number };
  extras: { stat: ItemStat; value: number }[];
  /** `null` — уровень в потолке аккаунта */
  upgrade: ItemCost | null;
  reroll: ItemCost | null;
  /** осколков его редкости за разбор */
  salvage: number;
}

export interface InventoryView {
  items: ItemView[];
  /** надетое по слотам */
  equipped: Partial<Record<ItemSlot, string>>;
  /** мощь надетого — её видно в профиле и рейтинге */
  power: number;
  capacity: number;
  /** потолок уровня предметов у аккаунта сейчас */
  levelCap: number;
  /** цена объединения трёх предметов редкости; нет ключа — выше не собирается */
  merge: Partial<Record<ItemRarity, ItemCost>>;
}

export function itemView(row: ItemRow, accountLevel: number): ItemView {
  const shape: ItemShape = row;
  return {
    itemId: row.itemId,
    slot: row.slot,
    rarity: row.rarity,
    level: row.level,
    equipped: row.equipped,
    power: itemPower(shape),
    main: { stat: row.rolls.main.stat, value: statValue(row.rolls.main.stat, row.rarity, row.level, row.rolls.main.roll) },
    extras: row.rolls.extras.map((extra) => ({ stat: extra.stat, value: statValue(extra.stat, row.rarity, row.level, extra.roll) })),
    upgrade: upgradeCost(shape, accountLevel),
    reroll: row.rolls.extras.length === 0 ? null : rerollCost(shape),
    salvage: salvageYield(shape),
  };
}

export function inventoryView(rows: readonly ItemRow[], accountLevel: number): InventoryView {
  const items = rows.map((row) => itemView(row, accountLevel));
  const equipped: Partial<Record<ItemSlot, string>> = {};
  let power = 0;
  for (const item of items) {
    if (!item.equipped) continue;
    equipped[item.slot] = item.itemId;
    power += item.power;
  }
  const merge: Partial<Record<ItemRarity, ItemCost>> = {};
  for (const rarity of ITEM_RARITIES) {
    const cost = mergeCost(rarity);
    if (cost !== null) merge[rarity] = cost;
  }
  return { items, equipped, power, capacity: INVENTORY_CAP, levelCap: levelCap(accountLevel), merge };
}
