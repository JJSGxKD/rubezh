/**
 * Каталог снаряжения (docs/35-stage4-plan.md §3.4, решение Р38). Числа
 * рабочие (Р31): правятся здесь, в карте конфигурации —
 * docs/30-configuration-map.md.
 *
 * Параметры предмета — те же, что принимает движок в наборе на забег
 * (`LOADOUT_STATS` в shared-types): снаряжение ничего не знает о бое, оно
 * лишь даёт прибавки к параметрам. Бэкенд не импортирует исходники пакетов
 * монорепо, поэтому имена здесь продублированы, а совпадение с движком
 * сверяет тест.
 */

export const ITEM_SLOTS = ["weapon", "amulet", "gloves", "armor", "belt", "boots"] as const;
export type ItemSlot = (typeof ITEM_SLOTS)[number];

export const ITEM_RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const;
export type ItemRarity = (typeof ITEM_RARITIES)[number];

export const ITEM_STATS = [
  "damage",
  "cooldown",
  "area",
  "projectileSpeed",
  "duration",
  "moveSpeed",
  "pickupRadius",
  "maxHp",
  "regenPerSec",
  "armor",
  "resistFire",
  "resistCold",
  "resistLightning",
  "resistPoison",
  "damageFire",
  "damageCold",
  "damageLightning",
  "damagePoison",
  "statusChance",
] as const;
export type ItemStat = (typeof ITEM_STATS)[number];

/**
 * Значение свойства на обычном предмете первого уровня при броске 1. Доли —
 * прибавки к множителю (0.03 — +3%), здоровье, восстановление и броня —
 * числом. Мощь у всех свойств на одной шкале: 10 за это значение.
 */
export const STAT_BASE: Readonly<Record<ItemStat, number>> = {
  damage: 0.03,
  cooldown: 0.02,
  area: 0.04,
  projectileSpeed: 0.05,
  duration: 0.04,
  moveSpeed: 0.02,
  pickupRadius: 0.06,
  maxHp: 6,
  regenPerSec: 0.1,
  armor: 0.3,
  resistFire: 0.03,
  resistCold: 0.03,
  resistLightning: 0.03,
  resistPoison: 0.03,
  damageFire: 0.05,
  damageCold: 0.05,
  damageLightning: 0.05,
  damagePoison: 0.05,
  statusChance: 0.05,
};

const ELEMENT_DAMAGE: readonly ItemStat[] = ["damageFire", "damageCold", "damageLightning", "damagePoison"];
const ELEMENT_RESIST: readonly ItemStat[] = ["resistFire", "resistCold", "resistLightning", "resistPoison"];

/** Главное свойство — одно на слот, по нему предмет узнаётся; пул — дополнительные без повторов. */
export const SLOT_BASES: Readonly<Record<ItemSlot, { main: ItemStat; pool: readonly ItemStat[] }>> = {
  weapon: { main: "damage", pool: ["cooldown", "area", "projectileSpeed", "duration", ...ELEMENT_DAMAGE, "statusChance"] },
  amulet: { main: "statusChance", pool: [...ELEMENT_DAMAGE, ...ELEMENT_RESIST, "duration", "pickupRadius"] },
  gloves: { main: "cooldown", pool: ["damage", "area", "projectileSpeed", "statusChance", ...ELEMENT_DAMAGE] },
  armor: { main: "maxHp", pool: ["armor", "regenPerSec", ...ELEMENT_RESIST] },
  belt: { main: "regenPerSec", pool: ["maxHp", "pickupRadius", "duration", ...ELEMENT_RESIST] },
  boots: { main: "moveSpeed", pool: ["pickupRadius", "armor", "resistCold", "regenPerSec"] },
};

export interface RarityRules {
  /** во сколько раз значения сильнее обычного предмета */
  valueMul: number;
  /** сколько дополнительных свойств */
  extras: number;
  /** множитель цены улучшения, перековки и объединения */
  costMul: number;
  /** осколков этой редкости при разборе предмета первого уровня */
  salvageShards: number;
}

export const RARITY_RULES: Readonly<Record<ItemRarity, RarityRules>> = {
  common: { valueMul: 1, extras: 0, costMul: 1, salvageShards: 3 },
  uncommon: { valueMul: 1.2, extras: 1, costMul: 1.5, salvageShards: 3 },
  rare: { valueMul: 1.45, extras: 2, costMul: 2.2, salvageShards: 4 },
  epic: { valueMul: 1.75, extras: 3, costMul: 3.2, salvageShards: 5 },
  legendary: { valueMul: 2.1, extras: 4, costMul: 4.5, salvageShards: 6 },
  // Мифическая — в схеме, но не выпадает и не собирается (Р25): ждёт
  // сезонного и топового контента.
  mythic: { valueMul: 2.5, extras: 4, costMul: 6, salvageShards: 8 },
};

/** Предел уровня предмета — и выпадения, и улучшения. */
export const MAX_ITEM_LEVEL = 30;
/** Прибавка множителя значений за каждый уровень сверх первого. */
export const LEVEL_STEP = 0.06;

/** Бросок главного свойства и дополнительных — доля от наибольшего значения. */
export const MAIN_ROLL = { min: 0.85, max: 1 } as const;
export const EXTRA_ROLL = { min: 0.6, max: 1 } as const;

/** Потолок инвентаря: неограниченный — это и таблица без конца, и невозможный экран. */
export const INVENTORY_CAP = 60;

/** Поправка уровня выпадения за сложность: сложнее бой — сильнее добыча. */
export const DIFFICULTY_LEVEL_BONUS: Readonly<Record<string, number>> = { easy: 0, normal: 1, hard: 2 };

/**
 * Добыча после забега (§3.4). Шанс растёт с временем забега, редкость — по
 * весам. Редкая — только по вердикту `ok`, эпическая и легендарная — после
 * перепроверки повтором (WP5, Р13): до неё выше редкой не выпадает.
 */
export const LOOT = {
  minSurvivalSec: 30,
  baseChance: 0.25,
  chancePerMinute: 0.05,
  maxChance: 0.9,
  weights: { common: 60, uncommon: 28, rare: 10, epic: 1.8, legendary: 0.2, mythic: 0 } as Readonly<Record<ItemRarity, number>>,
} as const;

/** Выше этой редкости объединение не собирает: мифическая не выпадает ниоткуда. */
export const MAX_MERGE_RESULT: ItemRarity = "legendary";
/** Сколько предметов одной редкости объединяются в один. */
export const MERGE_COUNT = 3;
