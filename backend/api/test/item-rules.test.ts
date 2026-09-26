import { LOADOUT_STATS } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { LOADOUT_BOUNDS } from "../../../packages/core-game/src/game/progression/run-loadout";
import {
  EXTRA_ROLL,
  ITEM_RARITIES,
  ITEM_SLOTS,
  ITEM_STATS,
  MAIN_ROLL,
  MAX_ITEM_LEVEL,
  RARITY_RULES,
  SLOT_BASES,
  type ItemRarity,
} from "../src/modules/items/item-catalog.js";
import {
  allowedRarities,
  dropChance,
  dropLevel,
  itemPower,
  levelCap,
  loadoutOf,
  mergeCost,
  nextRarity,
  rerollExtra,
  rollItem,
  rollLoot,
  seededRandom,
  upgradeCost,
  type ItemShape,
} from "../src/modules/items/item-rules.js";

// Правила снаряжения (docs/35-stage4-plan.md §3.4, Р38): бросок — в диапазонах
// по редкости на тысячах зёрен, значения не выходят за пределы движка, случайное
// повторяется от того же зерна, добыча слушается вердикта забега.

function item(slot: ItemShape["slot"], rarity: ItemRarity, level: number, seed = 1): ItemShape {
  return { slot, rarity, level, rolls: rollItem(seededRandom(seed), slot, rarity) };
}

describe("каталог снаряжения", () => {
  it("параметры — ровно те, что принимает движок в наборе на забег", () => {
    expect([...ITEM_STATS].sort()).toEqual([...LOADOUT_STATS].sort());
  });

  it("главное свойство слота не в его пуле, и пула хватает на самую щедрую редкость", () => {
    const most = Math.max(...Object.values(RARITY_RULES).map((rules) => rules.extras));
    for (const slot of ITEM_SLOTS) {
      expect(SLOT_BASES[slot].pool, slot).not.toContain(SLOT_BASES[slot].main);
      expect(new Set(SLOT_BASES[slot].pool).size, slot).toBeGreaterThanOrEqual(most);
    }
  });
});

describe("бросок предмета", () => {
  it("на тысяче зёрен: броски в диапазонах, число дополнительных — по редкости, без повторов", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const slot = ITEM_SLOTS[seed % ITEM_SLOTS.length] ?? "weapon";
      const rarity = ITEM_RARITIES[seed % 5] ?? "common";
      const rolls = rollItem(seededRandom(seed), slot, rarity);
      expect(rolls.main.stat).toBe(SLOT_BASES[slot].main);
      expect(rolls.main.roll).toBeGreaterThanOrEqual(MAIN_ROLL.min);
      expect(rolls.main.roll).toBeLessThanOrEqual(MAIN_ROLL.max);
      expect(rolls.extras).toHaveLength(RARITY_RULES[rarity].extras);
      expect(new Set(rolls.extras.map((extra) => extra.stat)).size).toBe(rolls.extras.length);
      for (const extra of rolls.extras) {
        expect(SLOT_BASES[slot].pool).toContain(extra.stat);
        expect(extra.roll).toBeGreaterThanOrEqual(EXTRA_ROLL.min);
        expect(extra.roll).toBeLessThanOrEqual(EXTRA_ROLL.max);
      }
    }
  });

  it("то же зерно — тот же предмет: спорный бросок можно повторить", () => {
    expect(rollItem(seededRandom(42), "amulet", "epic")).toEqual(rollItem(seededRandom(42), "amulet", "epic"));
    expect(rollItem(seededRandom(42), "amulet", "epic")).not.toEqual(rollItem(seededRandom(43), "amulet", "epic"));
  });

  it("перековка меняет одно дополнительное свойство без повтора, главное и остальные — нет", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const before = item("weapon", "legendary", 10, seed);
      const after = rerollExtra(seededRandom(seed + 10_000), before, 1);
      expect(after.main).toEqual(before.rolls.main);
      expect(after.extras.filter((_, index) => index !== 1)).toEqual(before.rolls.extras.filter((_, index) => index !== 1));
      expect(new Set(after.extras.map((extra) => extra.stat)).size).toBe(after.extras.length);
    }
  });
});

describe("значения и мощь", () => {
  it("полный набор легендарных предметов предельного уровня не выходит за пределы движка", () => {
    const set = ITEM_SLOTS.map((slot) => ({ ...item(slot, "legendary", MAX_ITEM_LEVEL), rolls: maxRolls(item(slot, "legendary", MAX_ITEM_LEVEL)) }));
    for (const [stat, value] of Object.entries(loadoutOf(set))) {
      expect(value, stat).toBeLessThan(LOADOUT_BOUNDS[stat as keyof typeof LOADOUT_BOUNDS]);
    }
  });

  it("мощь растёт с редкостью и уровнем", () => {
    const shape = item("armor", "rare", 5);
    expect(itemPower({ ...shape, level: 6 })).toBeGreaterThan(itemPower(shape));
    expect(itemPower({ ...shape, rarity: "epic" })).toBeGreaterThan(itemPower(shape));
  });
});

describe("цены", () => {
  it("улучшение упирается в потолок уровня аккаунта", () => {
    const shape = item("belt", "uncommon", levelCap(3));
    expect(upgradeCost(shape, 3)).toBeNull();
    expect(upgradeCost({ ...shape, level: 2 }, 3)).toEqual({ coins: 120, shards: 1 });
  });

  it("выше легендарной не объединяется, мифическая не собирается вовсе", () => {
    expect(nextRarity("epic")).toBe("legendary");
    expect(mergeCost("legendary")).toBeNull();
    expect(mergeCost("mythic")).toBeNull();
  });
});

describe("добыча", () => {
  it("редкая — только по вердикту ok, эпическая и выше — только после перепроверки", () => {
    expect(allowedRarities("rejected", true)).toEqual([]);
    expect(allowedRarities("suspicious", true)).toEqual(["common", "uncommon"]);
    expect(allowedRarities("ok", false)).toEqual(["common", "uncommon", "rare"]);
    expect(allowedRarities("ok", true)).toEqual(["common", "uncommon", "rare", "epic", "legendary"]);
  });

  it("на тысячах забегов без перепроверки эпического не выпадает, а короткий забег не даёт ничего", () => {
    const rarities = new Set<string>();
    for (let seed = 1; seed <= 3000; seed++) {
      const loot = rollLoot(seededRandom(seed), { survivalSec: 900, difficultyId: "hard", accountLevel: 10, verdict: "ok", replayVerified: false });
      if (loot !== null) rarities.add(loot.rarity);
      expect(rollLoot(seededRandom(seed), { survivalSec: 20, difficultyId: "hard", accountLevel: 10, verdict: "ok", replayVerified: true })).toBeNull();
    }
    expect([...rarities].sort()).toEqual(["common", "rare", "uncommon"]);
    expect(dropChance(20)).toBe(0);
  });

  it("уровень выпавшего — от аккаунта, сложности и минуты забега, не выше потолка", () => {
    expect(dropLevel({ accountLevel: 1, difficultyId: "easy", survivalSec: 60 })).toBe(1);
    expect(dropLevel({ accountLevel: 10, difficultyId: "hard", survivalSec: 900 })).toBe(1 + 5 + 2 + 3);
    expect(dropLevel({ accountLevel: 2, difficultyId: "hard", survivalSec: 99_999 })).toBe(levelCap(2));
  });
});

function maxRolls(shape: ItemShape): ItemShape["rolls"] {
  return { main: { ...shape.rolls.main, roll: 1 }, extras: shape.rolls.extras.map((extra) => ({ ...extra, roll: 1 })) };
}
