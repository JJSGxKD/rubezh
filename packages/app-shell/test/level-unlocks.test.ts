import { describe, expect, it } from "vitest";
import { ACCOUNT_UNLOCKS } from "@bh/core-game";
import "../src/i18n/account";
import { unlockLabel, unlocksGainedAt, unlocksGainedBetween } from "../src/state/level-unlocks";

// Что открывает уровень (docs/35-stage4-plan.md Р42): экран уровня и плашка
// после забега читают ту же таблицу разблокировок, что решает забег, — и
// говорят о слоте его номером, а не «ещё одним».

describe("что открывает уровень", () => {
  it("второй уровень — «Очаг» и третий слот оружия", () => {
    expect(unlocksGainedAt(2)).toEqual([
      { kind: "weapon", id: "hearth" },
      { kind: "weaponSlots", count: 3 },
    ]);
  });

  it("третий — навыки и второй слот атаки; первый — стартовый набор, он ничего не открывает", () => {
    expect(unlocksGainedAt(3)).toEqual([
      { kind: "passive", id: "reach" },
      { kind: "passive", id: "ward" },
      { kind: "passiveSlots", category: "attack", count: 2 },
    ]);
    expect(unlocksGainedAt(1)).toEqual([]);
  });

  it("за забег с двумя уровнями — открытое обоими, по порядку; после таблицы — ничего", () => {
    expect(unlocksGainedBetween(1, 3)).toEqual([...unlocksGainedAt(2), ...unlocksGainedAt(3)]);
    const last = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));
    expect(unlocksGainedAt(last + 1)).toEqual([]);
    expect(unlocksGainedBetween(4, 4)).toEqual([]);
  });

  it("подписи — именами для игрока, а не id", () => {
    expect(unlockLabel({ kind: "weapon", id: "hearth" })).toBe("оружие «Очаг»");
    expect(unlockLabel({ kind: "passive", id: "ward" })).toBe("навык «Броня»");
    expect(unlockLabel({ kind: "weaponSlots", count: 3 })).toBe("3-й слот оружия");
    expect(unlockLabel({ kind: "passiveSlots", category: "attack", count: 2 })).toBe("2-й слот «Атака»");
  });
});
