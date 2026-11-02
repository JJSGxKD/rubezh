import type { KeyValueStorage, RunResult } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { loadBestSurvivalSec, mergeBestSurvivalSec, submitRunResult } from "../src/game/run/records";

// Локальный рекорд при единой сложности (docs/35-stage4-plan.md, Р126, T-0190):
// единая сложность занимает место «hard», а рекорд прежней, более лёгкой
// «Сложной» сбрасывается — до него не дотянуться.

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

function resultWith(survivalSec: number, difficultyId: RunResult["difficultyId"]): RunResult {
  return { survivalSec, difficultyId } as RunResult;
}

/** Ключ, под которым прежняя сборка хранила рекорд «Сложной». */
const OLD_HARD_KEY = "bh.meta.v1.bestSurvivalSec.hard";

describe("рекорд единой сложности", () => {
  it("старое значение под прежним ключом hard не читается как рекорд", () => {
    const storage = memoryStorage({ [OLD_HARD_KEY]: "900" });
    expect(loadBestSurvivalSec(storage, "hard")).toBe(0);
  });

  it("забег хуже старого рекорда прежней сборки — уже рекорд единой сложности", () => {
    const storage = memoryStorage({ [OLD_HARD_KEY]: "900" });
    expect(submitRunResult(storage, resultWith(120, "hard"))).toEqual({ bestSurvivalSec: 120, isNewRecord: true });
    expect(loadBestSurvivalSec(storage, "hard")).toBe(120);
  });

  it("серверный рекорд не вытесняется старым локальным", () => {
    const storage = memoryStorage({ [OLD_HARD_KEY]: "900" });
    expect(mergeBestSurvivalSec(storage, "hard", 120)).toBe(120);
  });

  it("новый рекорд переживает перечитывание хранилища", () => {
    const storage = memoryStorage();
    submitRunResult(storage, resultWith(75, "hard"));
    expect(loadBestSurvivalSec(storage, "hard")).toBe(75);
  });
});

describe("рекорды easy и normal не менялись", () => {
  it("easy и normal читаются под прежними ключами", () => {
    const storage = memoryStorage({
      "bh.meta.v1.bestSurvivalSec.easy": "50",
      "bh.meta.v1.bestSurvivalSec.normal": "60",
    });
    expect(loadBestSurvivalSec(storage, "easy")).toBe(50);
    expect(loadBestSurvivalSec(storage, "normal")).toBe(60);
  });

  it("рекорд, поставленный до сложностей, переезжает на easy", () => {
    const storage = memoryStorage({ "bh.meta.v1.bestSurvivalSec": "74.2" });
    expect(loadBestSurvivalSec(storage, "easy")).toBe(74.2);
    expect(storage.values["bh.meta.v1.bestSurvivalSec"]).toBeUndefined();
    expect(storage.values["bh.meta.v1.bestSurvivalSec.easy"]).toBe("74.2");
  });

  it("прежний рекорд без сложности не попадает в hard", () => {
    const storage = memoryStorage({ "bh.meta.v1.bestSurvivalSec": "74.2" });
    expect(loadBestSurvivalSec(storage, "hard")).toBe(0);
  });
});
