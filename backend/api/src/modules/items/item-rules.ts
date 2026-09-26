import {
  DIFFICULTY_LEVEL_BONUS,
  EXTRA_ROLL,
  ITEM_RARITIES,
  ITEM_SLOTS,
  LEVEL_STEP,
  LOOT,
  MAIN_ROLL,
  MAX_ITEM_LEVEL,
  MAX_MERGE_RESULT,
  RARITY_RULES,
  SLOT_BASES,
  STAT_BASE,
  type ItemRarity,
  type ItemSlot,
  type ItemStat,
} from "./item-catalog.js";

/**
 * Правила снаряжения без базы и HTTP (docs/35-stage4-plan.md §3.4, Р38):
 * бросок, значения, мощь, цены, добыча. Всё случайное — от зерна: бросает
 * сервер своим генератором (Р14), а зерно хранится с предметом, и спорный
 * бросок можно повторить при разборе.
 *
 * У предмета хранятся **броски**, а не значения: значение считается из
 * редкости, уровня и броска. Поэтому улучшение уровня не перебрасывает
 * свойства — оно поднимает их все разом.
 */

export interface RolledStat {
  stat: ItemStat;
  /** доля от наибольшего значения, 0…1 */
  roll: number;
}

export interface ItemRolls {
  main: RolledStat;
  extras: RolledStat[];
}

export interface ItemShape {
  slot: ItemSlot;
  rarity: ItemRarity;
  level: number;
  rolls: ItemRolls;
}

export type Random = () => number;

/**
 * mulberry32 — простой и хорошо перемешанный 32-битный генератор. Криптостойкость
 * не нужна: зерно само берётся из криптографического источника, а генератор
 * лишь раскладывает его в броски воспроизводимо.
 */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(random: Random, range: { min: number; max: number }): number {
  return round(range.min + (range.max - range.min) * random(), 4);
}

function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("выбор из пустого списка");
  return item;
}

/** Броски нового предмета: главное свойство слота и дополнительные из пула без повторов. */
export function rollItem(random: Random, slot: ItemSlot, rarity: ItemRarity): ItemRolls {
  const base = SLOT_BASES[slot];
  const pool = [...base.pool];
  const extras: RolledStat[] = [];
  for (let index = 0; index < RARITY_RULES[rarity].extras && pool.length > 0; index++) {
    const stat = pick(random, pool);
    pool.splice(pool.indexOf(stat), 1);
    extras.push({ stat, roll: between(random, EXTRA_ROLL) });
  }
  return { main: { stat: base.main, roll: between(random, MAIN_ROLL) }, extras };
}

/**
 * Перековка одного дополнительного свойства: новое свойство из пула, но не
 * из тех, что уже есть на предмете, и новый бросок. Главное свойство не
 * перековывается — по нему предмет узнаётся.
 */
export function rerollExtra(random: Random, item: ItemShape, index: number): ItemRolls {
  const current = item.rolls.extras[index];
  if (current === undefined) throw new RangeError(`у предмета нет дополнительного свойства ${index}`);
  const taken = new Set(item.rolls.extras.filter((_, other) => other !== index).map((extra) => extra.stat));
  const pool = SLOT_BASES[item.slot].pool.filter((stat) => !taken.has(stat));
  const extras = [...item.rolls.extras];
  extras[index] = { stat: pick(random, pool), roll: between(random, EXTRA_ROLL) };
  return { main: item.rolls.main, extras };
}

export function levelMul(level: number): number {
  return 1 + LEVEL_STEP * (Math.min(Math.max(level, 1), MAX_ITEM_LEVEL) - 1);
}

/** Значение свойства: доли — до сотых процента, числа — до сотых. */
export function statValue(stat: ItemStat, rarity: ItemRarity, level: number, roll: number): number {
  const value = STAT_BASE[stat] * RARITY_RULES[rarity].valueMul * levelMul(level) * roll;
  return round(value, STAT_BASE[stat] < 1 ? 4 : 2);
}

/** Прибавки одного предмета по параметрам. */
export function itemModifiers(item: ItemShape): Partial<Record<ItemStat, number>> {
  const modifiers: Partial<Record<ItemStat, number>> = {};
  for (const rolled of [item.rolls.main, ...item.rolls.extras]) {
    modifiers[rolled.stat] = round((modifiers[rolled.stat] ?? 0) + statValue(rolled.stat, item.rarity, item.level, rolled.roll), 4);
  }
  return modifiers;
}

/** Набор на забег из надетого: прибавки складываются по параметрам. */
export function loadoutOf(items: readonly ItemShape[]): Partial<Record<ItemStat, number>> {
  const total: Partial<Record<ItemStat, number>> = {};
  for (const item of items) {
    for (const [stat, value] of Object.entries(itemModifiers(item)) as [ItemStat, number][]) {
      total[stat] = round((total[stat] ?? 0) + value, 4);
    }
  }
  return total;
}

/** Мощь — одна шкала для всех параметров: 10 за базовое значение свойства (Р38). */
export function itemPower(item: ItemShape): number {
  const rolls = [item.rolls.main, ...item.rolls.extras].reduce((sum, rolled) => sum + rolled.roll, 0);
  return Math.round(10 * RARITY_RULES[item.rarity].valueMul * levelMul(item.level) * rolls);
}

/** Потолок уровня предмета у аккаунта: растёт с уровнем аккаунта до общего предела. */
export function levelCap(accountLevel: number): number {
  return Math.min(MAX_ITEM_LEVEL, 5 + Math.max(accountLevel, 1));
}

export interface ItemCost {
  coins: number;
  /** осколков редкости самого предмета */
  shards: number;
}

/** Улучшение на уровень; `null` — уровень упёрся в потолок аккаунта. */
export function upgradeCost(item: ItemShape, accountLevel: number): ItemCost | null {
  if (item.level >= levelCap(accountLevel)) return null;
  return { coins: Math.round(40 * item.level * RARITY_RULES[item.rarity].costMul), shards: 1 + Math.floor(item.level / 4) };
}

export function rerollCost(item: ItemShape): ItemCost {
  return { coins: Math.round(60 * RARITY_RULES[item.rarity].costMul * (1 + item.level / 10)), shards: 0 };
}

/** Объединение трёх предметов этой редкости; `null` — выше не собирается. */
export function mergeCost(rarity: ItemRarity): ItemCost | null {
  if (nextRarity(rarity) === null) return null;
  return { coins: Math.round(100 * RARITY_RULES[rarity].costMul), shards: 5 };
}

export function nextRarity(rarity: ItemRarity): ItemRarity | null {
  if (rarity === MAX_MERGE_RESULT) return null;
  const next = ITEM_RARITIES[ITEM_RARITIES.indexOf(rarity) + 1];
  return next === undefined || rarity === "mythic" ? null : next;
}

/** Осколки редкости предмета за разбор — больше за прокачанный. */
export function salvageYield(item: ItemShape): number {
  return RARITY_RULES[item.rarity].salvageShards + Math.floor(item.level / 5);
}

export type RunVerdict = "ok" | "suspicious" | "rejected";

export interface LootInput {
  survivalSec: number;
  difficultyId: string;
  accountLevel: number;
  verdict: RunVerdict;
  /** забег перепроверен повтором (WP5); до перепроверки эпической и выше нет */
  replayVerified: boolean;
}

export interface LootRoll {
  slot: ItemSlot;
  rarity: ItemRarity;
  level: number;
}

/** Уровень выпавшего предмета: от уровня аккаунта, сложности и минуты забега (§3.4). */
export function dropLevel(input: Pick<LootInput, "accountLevel" | "difficultyId" | "survivalSec">): number {
  const level =
    1 + Math.floor(input.accountLevel / 2) + (DIFFICULTY_LEVEL_BONUS[input.difficultyId] ?? 0) + Math.floor(input.survivalSec / 300);
  return Math.min(Math.max(level, 1), levelCap(input.accountLevel));
}

export function dropChance(survivalSec: number): number {
  if (survivalSec < LOOT.minSurvivalSec) return 0;
  return Math.min(LOOT.maxChance, LOOT.baseChance + LOOT.chancePerMinute * Math.floor(survivalSec / 60));
}

/** Какие редкости может дать забег с таким вердиктом (Р13). */
export function allowedRarities(verdict: RunVerdict, replayVerified: boolean): ItemRarity[] {
  if (verdict === "rejected") return [];
  const allowed: ItemRarity[] = ["common", "uncommon"];
  if (verdict === "ok") allowed.push("rare");
  if (verdict === "ok" && replayVerified) allowed.push("epic", "legendary");
  return allowed;
}

/** Добыча забега; `null` — ничего не выпало. */
export function rollLoot(random: Random, input: LootInput): LootRoll | null {
  const allowed = allowedRarities(input.verdict, input.replayVerified);
  if (allowed.length === 0 || random() >= dropChance(input.survivalSec)) return null;

  const total = allowed.reduce((sum, rarity) => sum + LOOT.weights[rarity], 0);
  let point = random() * total;
  let rarity: ItemRarity = allowed[0] ?? "common";
  for (const candidate of allowed) {
    point -= LOOT.weights[candidate];
    if (point < 0) {
      rarity = candidate;
      break;
    }
  }
  return { slot: pick(random, ITEM_SLOTS), rarity, level: dropLevel(input) };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
