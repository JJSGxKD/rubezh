import { describe, expect, it } from "vitest";
import { t } from "../src/i18n";
import {
  difficultyForNextRun,
  historyDifficultyKey,
  RATED_DIFFICULTY_ID,
  TUTORIAL_DIFFICULTY_ID,
} from "../src/state/difficulty";

// Единая сложность (docs/35-stage4-plan.md, Р126, T-0190): выбора нет,
// сложность зависит только от числа законченных забегов аккаунта.

describe("сложность следующего забега", () => {
  it("у аккаунта без забегов — обучающая", () => {
    expect(difficultyForNextRun(0)).toBe("easy");
  });

  it("после первого забега — единая", () => {
    expect(difficultyForNextRun(1)).toBe("hard");
    expect(difficultyForNextRun(7)).toBe("hard");
    expect(difficultyForNextRun(0.5)).toBe("hard");
  });

  it("битое число забегов считается нулём", () => {
    expect(difficultyForNextRun(-1)).toBe("easy");
    expect(difficultyForNextRun(Number.NaN)).toBe("easy");
  });

  it("единая сложность занимает место hard, обучение — easy", () => {
    expect(RATED_DIFFICULTY_ID).toBe("hard");
    expect(TUTORIAL_DIFFICULTY_ID).toBe("easy");
  });
});

describe("плашка сложности в истории", () => {
  it("у единой сложности плашки нет", () => {
    expect(historyDifficultyKey("hard")).toBeNull();
  });

  it("у обучения и прежней нормальной — есть", () => {
    expect(historyDifficultyKey("easy")).toBe("difficulty.easy.name");
    expect(historyDifficultyKey("normal")).toBe("difficulty.normal.name");
  });

  it("тексты плашек есть в словаре", () => {
    expect(t("difficulty.easy.name")).toBe("Обучение");
    expect(t("difficulty.normal.name")).not.toBe("difficulty.normal.name");
  });
});
