import { describe, expect, it } from "vitest";
import { mainAccrual } from "../src/state/ui-feedback";

// Звук начисления (design/art/direction-v2.md §7.6): награда из нескольких
// валют звучит самой ценной — самоцвет слышнее монет, монеты — осколков.

describe("каким звуком звучит награда", () => {
  it("самоцветы перекрывают монеты и осколки", () => {
    expect(mainAccrual({ coins: 500, gems: 1, shards: 3 })).toBe("gems");
  });

  it("без самоцветов — монеты, без монет — осколки", () => {
    expect(mainAccrual({ coins: 50, gems: 0, shards: 2 })).toBe("coins");
    expect(mainAccrual({ coins: 0, gems: 0, shards: 2 })).toBe("shards");
  });

  it("пустая награда — без звука начисления, только общий звон", () => {
    expect(mainAccrual({ coins: 0, gems: 0, shards: 0 })).toBeNull();
  });
});
