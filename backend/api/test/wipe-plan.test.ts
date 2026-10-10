import { describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client.js";
import { WIPE_ORDER, WIPE_PLAN } from "../src/modules/wipe/wipe-plan.js";

/**
 * План вайпа (docs/35-stage4-plan.md, Р87): у каждой модели схемы записано
 * решение «стираем» или «оставляем», порядок стирания задан списком. Тест
 * падает, когда в схеме появилась таблица без решения.
 */

const MODELS = Object.values(Prisma.ModelName);
const plan: Record<string, { action: string; why: string }> = WIPE_PLAN;
const order: readonly string[] = WIPE_ORDER;

describe("план вайпа: полнота", () => {
  it("у каждой модели схемы есть решение", () => {
    const missing = MODELS.filter((model) => plan[model] === undefined);
    expect(missing, `модели без решения в WIPE_PLAN: ${missing.join(", ")}`).toEqual([]);
  });

  it("в плане нет моделей, которых нет в схеме", () => {
    const extra = Object.keys(plan).filter((name) => !(MODELS as string[]).includes(name));
    expect(extra, `лишние строки в WIPE_PLAN: ${extra.join(", ")}`).toEqual([]);
  });

  it("у каждого решения есть причина", () => {
    const empty = Object.entries(plan)
      .filter(([, decision]) => decision.why.trim() === "")
      .map(([model]) => model);
    expect(empty, `пустое why у: ${empty.join(", ")}`).toEqual([]);
  });

  it("действие — keep или wipe", () => {
    for (const [model, decision] of Object.entries(plan)) {
      expect(["keep", "wipe"], model).toContain(decision.action);
    }
  });

  it("остаётся 55 моделей, стирается 18", () => {
    const actions = Object.values(plan).map((decision) => decision.action);
    expect(actions.filter((action) => action === "keep")).toHaveLength(55);
    expect(actions.filter((action) => action === "wipe")).toHaveLength(18);
  });
});

describe("план вайпа: порядок стирания", () => {
  it("ровно модели с action wipe, без повторов", () => {
    const wiped = Object.entries(plan)
      .filter(([, decision]) => decision.action === "wipe")
      .map(([model]) => model)
      .sort();
    expect(new Set(order).size).toBe(order.length);
    expect([...order].sort()).toEqual(wiped);
  });

  it("порядок задан списком из задачи", () => {
    expect(order).toEqual([
      "RunAdContinue",
      "RunReward",
      "RunBoost",
      "TaskRun",
      "Run",
      "TaskProgress",
      "ShowcaseOffer",
      "ItemEvent",
      "Item",
      "WalletEntry",
      "WalletBalance",
      "WalletDaily",
      "AccountProgress",
      "FriendGift",
      "DailyReward",
      "WheelSpin",
      "VipDaily",
      "Notification",
    ]);
  });

  it("Run стоит позже RunAdContinue и RunReward", () => {
    expect(order.indexOf("Run")).toBeGreaterThan(order.indexOf("RunAdContinue"));
    expect(order.indexOf("Run")).toBeGreaterThan(order.indexOf("RunReward"));
  });

  it("Item стоит позже ItemEvent и ShowcaseOffer", () => {
    expect(order.indexOf("Item")).toBeGreaterThan(order.indexOf("ItemEvent"));
    expect(order.indexOf("Item")).toBeGreaterThan(order.indexOf("ShowcaseOffer"));
  });
});

describe("план вайпа: то, что остаётся по решению Р87", () => {
  // смена любой из этих строк — изменение Р87, а не правка плана
  it.each(["Purchase", "Account", "Friendship", "ReferralBinding", "VipPeriod", "AccountRestriction", "AnalyticsEvent"])("%s остаётся", (model) => {
    expect(plan[model]?.action).toBe("keep");
  });
});
