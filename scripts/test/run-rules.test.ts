import { describe, expect, it } from "vitest";
import { DIFFICULTIES as CONTENT_DIFFICULTIES } from "../../packages/core-game/src/content/difficulty";
import { LOADOUT_LIMITS } from "../../packages/core-game/src/content/upgrades";
import { DIFFICULTIES, MAX_WEAPONS } from "../../backend/api/src/modules/runs/run-rules.js";

// Правила игры на сервере — копия чисел из контента, а не импорт: собранный
// бэкенд не импортирует исходники пакетов монорепо. Копия не имеет права
// разойтись с контентом молча — иначе геймдизайнер добавит четвёртый слот
// под оружие, и каждый честный забег с четырьмя оружиями получит отказ.

describe("правила игры на сервере совпадают с контентом", () => {
  it("число слотов под оружие", () => {
    expect(MAX_WEAPONS, "поменяйте MAX_WEAPONS в backend/api/src/modules/runs/run-rules.ts").toBe(LOADOUT_LIMITS.weapons);
  });

  it("список сложностей", () => {
    expect([...DIFFICULTIES].sort()).toEqual(CONTENT_DIFFICULTIES.map((difficulty) => difficulty.id).sort());
  });
});
