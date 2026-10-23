import { describe, expect, it } from "vitest";
import { ACCOUNT_UNLOCKS, PASSIVES, WEAPONS } from "@bh/core-game";
import "../src/i18n/account";
import { t } from "../src/i18n";
import { collectionByLevel, nextUnlockAfter, nextUnlockLabel, unlockLabel, unlocksGainedAt, unlocksGainedBetween } from "../src/state/level-unlocks";

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
      { kind: "passiveSlots", category: "attack", count: 2 },
    ]);
    expect(unlocksGainedAt(1)).toEqual([]);
  });

  it("за забег с двумя уровнями — открытое обоими, по порядку; после таблицы — ничего", () => {
    expect(unlocksGainedBetween(1, 3)).toEqual([...unlocksGainedAt(2), ...unlocksGainedAt(3)]);
    const last = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));
    expect(unlocksGainedAt(last + 1)).toEqual([]);
    expect(unlocksGainedBetween(5, 5)).toEqual([]);
  });

  it("лестница: «Буря» на 4-м, пустой пятый, «Броня» на 6-м, «Закалка» на 14-м", () => {
    expect(unlocksGainedAt(4)).toEqual([{ kind: "weapon", id: "storm" }]);
    expect(unlocksGainedAt(5)).toEqual([]);
    expect(unlocksGainedAt(14)).toEqual([{ kind: "passive", id: "tempering" }]);
    expect(unlocksGainedBetween(3, 6)).toEqual([
      { kind: "weapon", id: "storm" },
      { kind: "passive", id: "ward" },
    ]);
  });

  it("подписи — именами для игрока, а не id", () => {
    expect(unlockLabel({ kind: "weapon", id: "hearth" })).toBe("оружие «Очаг»");
    expect(unlockLabel({ kind: "passive", id: "ward" })).toBe("навык «Броня»");
    expect(unlockLabel({ kind: "weaponSlots", count: 3 })).toBe("3-й слот оружия");
    expect(unlockLabel({ kind: "passiveSlots", category: "attack", count: 2 })).toBe("2-й слот «Атака»");
  });
});

describe("что откроется дальше", () => {
  it("ближайший уровень с открытием, пустые пропускаются", () => {
    expect(nextUnlockAfter(1)).toEqual({
      level: 2,
      unlocks: [
        { kind: "weapon", id: "hearth" },
        { kind: "weaponSlots", count: 3 },
      ],
    });
    expect(nextUnlockAfter(4)?.level).toBe(6);
    expect(nextUnlockAfter(4)?.unlocks).toEqual([{ kind: "passive", id: "ward" }]);
    expect(nextUnlockAfter(5)?.level).toBe(6);
  });

  it("на последнем уровне лестницы и выше — ничего", () => {
    expect(nextUnlockAfter(14)).toBeNull();
    expect(nextUnlockAfter(99)).toBeNull();
  });

  it("подпись — именем из словаря, а не вписанным", () => {
    const next = nextUnlockAfter(3);
    expect(next).not.toBeNull();
    if (next === null) return;
    expect(nextUnlockLabel(next)).toBe(`Дальше: на 4-м уровне — оружие «${t("weapon.storm.name")}»`);
  });
});

describe("коллекция на экране уровня", () => {
  it("всё оружие и все навыки контента — каждый со своим уровнем открытия", () => {
    const { weapons, passives } = collectionByLevel();
    expect(weapons.map((item) => item.id).sort()).toEqual(WEAPONS.map((weapon) => weapon.id).sort());
    expect(passives.map((item) => item.id).sort()).toEqual(PASSIVES.map((passive) => passive.id).sort());
    expect(weapons.find((item) => item.id === "spark")?.level).toBe(1);
    expect(weapons.find((item) => item.id === "hearth")?.level).toBe(2);
    expect(passives.find((item) => item.id === "tempering")?.level).toBe(14);
  });

  it("по порядку открытия: что ближе — то раньше в ряду", () => {
    for (const list of Object.values(collectionByLevel())) {
      const levels = list.map((item) => item.level);
      expect(levels).toEqual([...levels].sort((a, b) => a - b));
    }
  });

  it("уровень открытия — тот же, что у таблицы забега", () => {
    for (const { id, level } of collectionByLevel().weapons) {
      expect(unlocksGainedAt(level).some((unlock) => unlock.kind === "weapon" && unlock.id === id) || level === 1).toBe(true);
    }
  });
});
