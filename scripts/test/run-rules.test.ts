import { describe, expect, it } from "vitest";
import { CONTINUE } from "../../packages/core-game/src/content/continue";
import { DIFFICULTIES as CONTENT_DIFFICULTIES } from "../../packages/core-game/src/content/difficulty";
import { RUN_MODES as CONTENT_RUN_MODES } from "../../packages/shared-types/src/index";
import { LOADOUT_LIMITS } from "../../packages/core-game/src/content/upgrades";
import { CONTINUES_PER_RUN, DIFFICULTIES, MAX_WEAPONS, RATED_DIFFICULTIES, RUN_MODES } from "../../backend/api/src/modules/runs/run-rules.js";

// Правила игры на сервере — копия чисел из контента, а не импорт: собранный
// бэкенд не импортирует исходники пакетов монорепо. Копия не имеет права
// разойтись с контентом молча — иначе геймдизайнер добавит четвёртый слот
// под оружие, и каждый честный забег с четырьмя оружиями получит отказ.

describe("правила игры на сервере совпадают с контентом", () => {
  it("число слотов под оружие", () => {
    expect(MAX_WEAPONS, "поменяйте MAX_WEAPONS в backend/api/src/modules/runs/run-rules.ts").toBe(LOADOUT_LIMITS.weapons);
  });

  it("число вторых шансов за забег", () => {
    // Разойдётся — сервер либо продаст продолжение, которое игра не даст
    // применить, либо откажет в том, которое она предлагает.
    expect(CONTINUES_PER_RUN, "поменяйте CONTINUES_PER_RUN в backend/api/src/modules/runs/run-rules.ts").toBe(CONTINUE.perRun);
  });

  it("список сложностей", () => {
    expect([...DIFFICULTIES].sort()).toEqual(CONTENT_DIFFICULTIES.map((difficulty) => difficulty.id).sort());
  });

  it("список режимов забега", () => expect([...RUN_MODES]).toEqual([...CONTENT_RUN_MODES]));

  it("рейтинговые сложности есть среди сложностей контента", () => {
    // Р126: рейтинг считает единую сложность. Убрали её из контента — рейтинг
    // остался бы без единой допустимой сложности.
    const contentIds = CONTENT_DIFFICULTIES.map((difficulty) => difficulty.id as string);
    expect(RATED_DIFFICULTIES.length).toBeGreaterThan(0);
    for (const difficulty of RATED_DIFFICULTIES) {
      expect(contentIds, `рейтинговой сложности ${difficulty} нет в контенте: поправьте RATED_DIFFICULTIES в backend/api/src/modules/runs/run-rules.ts`).toContain(difficulty);
    }
  });
});
