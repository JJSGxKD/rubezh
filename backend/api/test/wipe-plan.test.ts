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

  it("остаётся 93 модели, стирается 28", () => {
    const actions = Object.values(plan).map((decision) => decision.action);
    expect(actions.filter((action) => action === "keep")).toHaveLength(93);
    expect(actions.filter((action) => action === "wipe")).toHaveLength(28);
  });

  it("батл-пасс (T-0311): очки, журнал забора и подарки-бусты стираются, лента месяца остаётся", () => {
    for (const model of ["PassProgress", "PassClaim", "BoostCredit"]) expect(plan[model]?.action, model).toBe("wipe");
    expect(plan.PassSeason?.action).toBe("keep");
  });

  it("контент игры на сервере (T-0303) остаётся: это правила игры, а не данные игроков", () => {
    for (const model of ["ContentVersion", "ContentDraft", "ContentCheck"]) expect(plan[model]?.action, model).toBe("keep");
  });

  it("связь с аккаунтом MAX или VK (T-0377) остаётся: она постоянна, как привязки приглашения и источника (Р188)", () => {
    expect(plan.ExternalIdentity?.action).toBe("keep");
    expect(plan.ExternalIdentity?.why).toContain("постоянна");
    expect(order).not.toContain("ExternalIdentity");
  });

  it("второй шанс за самоцветы стирается своим шагом рядом с рекламным и до забега, а не только каскадом", () => {
    expect(plan.RunGemContinue?.action).toBe("wipe");
    expect(plan.RunGemContinue?.why).toContain("часть забега");
    expect(order.indexOf("RunGemContinue")).toBe(order.indexOf("RunAdContinue") + 1);
    expect(order.indexOf("RunGemContinue")).toBeLessThan(order.indexOf("Run"));
  });

  it("рекламный переброс карточек (T-0199) — часть забега: стирается своим шагом до забега, а не только каскадом", () => {
    expect(plan.RunAdReroll?.action).toBe("wipe");
    expect(plan.RunAdReroll?.why).toContain("часть забега");
    expect(order.indexOf("RunAdReroll")).toBeLessThan(order.indexOf("Run"));
  });

  it("запись забега для проверки стирается своим шагом до забега (T-0317), а не только каскадом", () => {
    expect(plan.RunProof?.action).toBe("wipe");
    expect(plan.RunProof?.why).toContain("часть забега");
    expect(order.indexOf("RunProof")).toBeLessThan(order.indexOf("Run"));
  });
});

describe("план вайпа: компенсации тестерам", () => {
  it("TesterCompensation остаётся: компенсации выдаются после вайпа", () => {
    expect(plan.TesterCompensation).toEqual({ action: "keep", why: "компенсации тестерам выдаются после вайпа" });
  });

  it("знак «Тестер» живёт в Account, а он остаётся", () => {
    expect(plan.Account?.action).toBe("keep");
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
      "RunGemContinue",
      "RunAdReroll",
      "RunProof",
      "RunReward",
      "RunBoost",
      "TaskRun",
      "Run",
      "TaskProgress",
      "TaskPointsClaim",
      "TaskChannelWatch",
      "AchievementFavorite",
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
      "BotMentionTask",
      "PassProgress",
      "PassClaim",
      "BoostCredit",
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
