import { describe, expect, it } from "vitest";
import { ACCOUNT_UNLOCKS } from "../../packages/core-game/src/content/unlocks";
import { POWER_PROFILES } from "../../packages/core-game/src/game/balance/power-profiles";
import { ITEM_SLOTS, RARITY_RULES, SLOT_BASES, type ItemRarity, type ItemStat } from "../../backend/api/src/modules/items/item-catalog.js";
import { levelCap, loadoutOf, type ItemShape } from "../../backend/api/src/modules/items/item-rules.js";

// Профили силы калибровки (tasks/T-0196, решение 1) — данные в движке, а каталог
// предметов — на сервере. Движок не может импортировать бэкенд, поэтому числа
// профилей лежат литералом, а этот тест держит их равными тому, что дал бы
// каталог. Правка каталога без профилей — красный тест с готовыми числами.

/** Канонический набор: по слоту главное свойство и первые `extras` свойств пула, один бросок. */
function canonicalSet(rarity: ItemRarity, level: number, roll: number): ItemShape[] {
  return ITEM_SLOTS.map((slot) => {
    const base = SLOT_BASES[slot];
    return {
      slot,
      rarity,
      level,
      rolls: {
        main: { stat: base.main, roll },
        extras: base.pool.slice(0, RARITY_RULES[rarity].extras).map((stat) => ({ stat, roll })),
      },
    };
  });
}

function compare(label: string, actual: Partial<Record<ItemStat, number>>, expected: Readonly<Partial<Record<string, number>>>): void {
  const computed = JSON.stringify(actual);
  const stats = new Set<string>([...Object.keys(actual), ...Object.keys(expected)]);
  for (const stat of stats) {
    const want = actual[stat as ItemStat] ?? 0;
    const have = expected[stat] ?? 0;
    expect(have, `${label}: ${stat}; вычислено ${computed}`).toBeCloseTo(want, 4);
  }
}

describe("профили силы и каталог предметов", () => {
  const topLevel = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));

  it("средний — шесть редких предметов 10-го уровня с броском 0,8", () => {
    const items = canonicalSet("rare", 10, 0.8);
    compare("average", loadoutOf(items), POWER_PROFILES.average.loadout.modifiers);
    expect(10).toBeLessThanOrEqual(levelCap(POWER_PROFILES.average.loadout.accountLevel ?? 1));
  });

  it("полный арсенал — шесть легендарных предметов на потолке уровня предмета с броском 1", () => {
    const cap = levelCap(topLevel);
    const items = canonicalSet("legendary", cap, 1);
    compare("full", loadoutOf(items), POWER_PROFILES.full.loadout.modifiers);
    expect(cap).toBeLessThanOrEqual(levelCap(POWER_PROFILES.full.loadout.accountLevel ?? 1));
  });

  it("новичок идёт без снаряжения", () => {
    expect(POWER_PROFILES.novice.loadout.modifiers).toEqual({});
  });
});
