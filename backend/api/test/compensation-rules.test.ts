import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONTINUE_RATE, TESTER_BONUS, bonusGems, compensationGrantsSchema, continueGems, grantOfKey } from "../src/modules/wipe/compensation-rules.js";

/**
 * Правила компенсации тестеру (docs/35-stage4-plan.md, Р87, tasks/T-0040):
 * бонус за уровень, разбор ключа выдачи покупки и схема, по которой выдача
 * (T-0042) читает `grants` из базы.
 */

describe("бонус тестеру", () => {
  it("5 самоцветов за уровень, не больше 250", () => {
    expect(TESTER_BONUS).toEqual({ gemsPerLevel: 5, maxGems: 250 });
  });

  it.each([
    [0, 5],
    [1, 5],
    [2, 10],
    [12, 60],
    [49, 245],
    [50, 250],
    [51, 250],
    [80, 250],
  ])("уровень %i — %i самоцветов", (level, gems) => {
    expect(bonusGems(level)).toBe(gems);
  });

  it("отрицательный и нечисловой уровень считается первым", () => {
    expect(bonusGems(-4)).toBe(5);
    expect(bonusGems(Number.NaN)).toBe(5);
    expect(bonusGems(Number.POSITIVE_INFINITY)).toBe(5);
  });

  it("дробный уровень округляется вниз и остаётся целым числом самоцветов", () => {
    expect(bonusGems(12.9)).toBe(60);
    expect(Number.isInteger(bonusGems(7.5))).toBe(true);
  });
});

describe("ключ выдачи покупки", () => {
  const purchaseId = randomUUID();

  it("purchase:<uuid>:<ресурс> разбирается в выдачу", () => {
    expect(grantOfKey(`purchase:${purchaseId}:gems`, 150)).toEqual({ purchaseId, resource: "gems", amount: 150 });
    expect(grantOfKey(`purchase:${purchaseId}:shard_epic`, 3)).toEqual({ purchaseId, resource: "shard_epic", amount: 3 });
  });

  it("чужой ключ — null", () => {
    expect(grantOfKey(`purchase:${purchaseId}:unknown`, 150)).toBeNull();
    expect(grantOfKey(`adjust:${purchaseId}:gems`, 150)).toBeNull();
    expect(grantOfKey("purchase:not-uuid:gems", 150)).toBeNull();
  });

  it("лишние и недостающие части ключа — null", () => {
    expect(grantOfKey(`purchase:${purchaseId}`, 150)).toBeNull();
    expect(grantOfKey(`purchase:${purchaseId}:gems:extra`, 150)).toBeNull();
    expect(grantOfKey(`xpurchase:${purchaseId}:gems`, 150)).toBeNull();
    expect(grantOfKey("", 150)).toBeNull();
  });

  it("не начисление — null: нулевая и отрицательная сумма, дробная и нечисловая", () => {
    expect(grantOfKey(`purchase:${purchaseId}:gems`, 0)).toBeNull();
    expect(grantOfKey(`purchase:${purchaseId}:gems`, -5)).toBeNull();
    expect(grantOfKey(`purchase:${purchaseId}:gems`, 1.5)).toBeNull();
    expect(grantOfKey(`purchase:${purchaseId}:gems`, Number.NaN)).toBeNull();
  });
});

describe("схема grants", () => {
  const purchaseId = randomUUID();

  it("принимает выдачи, как их записывает снимок", () => {
    const grants = [
      { purchaseId, resource: "gems", amount: 150 },
      { purchaseId, resource: "shard_rare", amount: 2 },
    ];
    expect(compensationGrantsSchema.parse(grants)).toEqual(grants);
  });

  it("принимает пустой список: тестер без покупок", () => {
    expect(compensationGrantsSchema.parse([])).toEqual([]);
  });

  it("отклоняет нулевую сумму", () => {
    expect(compensationGrantsSchema.safeParse([{ purchaseId, resource: "gems", amount: 0 }]).success).toBe(false);
  });

  it("отклоняет отрицательную и дробную сумму", () => {
    expect(compensationGrantsSchema.safeParse([{ purchaseId, resource: "gems", amount: -1 }]).success).toBe(false);
    expect(compensationGrantsSchema.safeParse([{ purchaseId, resource: "gems", amount: 1.5 }]).success).toBe(false);
  });

  it("отклоняет незнакомый ресурс", () => {
    expect(compensationGrantsSchema.safeParse([{ purchaseId, resource: "diamonds", amount: 5 }]).success).toBe(false);
  });

  it("отклоняет purchaseId не в виде uuid и недостающие поля", () => {
    expect(compensationGrantsSchema.safeParse([{ purchaseId: "p-1", resource: "gems", amount: 5 }]).success).toBe(false);
    expect(compensationGrantsSchema.safeParse([{ purchaseId, resource: "gems" }]).success).toBe(false);
  });

  it("не массив — отказ", () => {
    expect(compensationGrantsSchema.safeParse({ purchaseId, resource: "gems", amount: 5 }).success).toBe(false);
    expect(compensationGrantsSchema.safeParse(null).success).toBe(false);
  });
});

describe("компенсация второго шанса (T-0042)", () => {
  it("курс — пара целых «6 самоцветов за 5 звёзд»: дробный множитель дал бы шум округления", () => {
    expect(CONTINUE_RATE).toEqual({ gems: 6, stars: 5 });
  });

  it.each([
    [0, 0],
    [1, 2],
    [3, 4],
    [5, 6],
    [7, 9],
    [10, 12],
    [50, 60],
  ])("%i ⭐ второго шанса — %i самоцветов, вверх до целого", (stars, gems) => {
    expect(continueGems(stars)).toBe(gems);
  });

  it("всегда целое число самоцветов", () => {
    for (let stars = 0; stars <= 200; stars += 1) expect(Number.isInteger(continueGems(stars))).toBe(true);
  });
});
