import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { playerCardSchema, type PlayerCard } from "../src/api/players";
import type { Restriction } from "../src/api/restrictions";
import { PlayerSummary } from "../src/screens/players/PlayerSummary";
import { bestRun, CARD_TABS, cardTabOf, MILESTONE_CHAIN, shortId, summaryNumbers, tabCounts } from "../src/screens/players/card-rules";

// Карточка игрока вкладками (tasks/T-0054): что на вкладках, цифры «Сводки».

const AT = "2026-10-01T12:00:00.000Z";
const ACCOUNT = "3f2a1b7c-9d0e-4c55-9d0e-6f3b2a1c91c0";

function purchase(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    purchaseId: "p",
    product: "shop_item",
    sku: "gems_60",
    runId: null,
    continueNo: null,
    priceStars: 50,
    chargedStars: 50,
    mode: "live",
    status: "paid",
    invoicedAt: AT,
    paidAt: AT,
    refundReason: null,
    refundedAt: null,
    fulfilledAt: AT,
    refundRequestedAt: null,
    actions: [],
    ...patch,
  };
}

function cardOf(patch: Record<string, unknown> = {}): PlayerCard {
  return playerCardSchema.parse({
    account: { accountId: ACCOUNT, platform: "telegram", displayName: "Аня", photoUrl: null, createdAt: AT, banned: null, pii: { platformUserId: "555", username: "ann" } },
    roles: [],
    funnel: null,
    acquisition: null,
    messaging: null,
    progress: { level: 3, xp: 120, xpIntoLevel: 20, xpForNext: 80 },
    runs: { runs: 1, totalKills: 10, totalSurvivalSec: 100, best: { easy: null, normal: null, hard: null }, recent: [] },
    wallet: { balances: { coins: 150, gems: 5 }, entries: [] },
    purchases: [],
    ...patch,
  });
}

function restriction(kind: string, state = "active"): Restriction {
  return {
    restrictionId: `${kind}-${state}`,
    kind,
    title: kind,
    state,
    startsAt: AT,
    endsAt: null,
    reason: "spam",
    reasonTitle: "Спам",
    comment: null,
    notify: true,
    imposedBy: null,
    liftedAt: null,
    liftedBy: null,
    liftComment: null,
  } as unknown as Restriction;
}

describe("вкладки карточки", () => {
  it("шесть вкладок в порядке макета", () => {
    expect(CARD_TABS.map((tab) => tab.id)).toEqual(["summary", "runs", "purchases", "wallet", "friends", "restrictions"]);
    expect(CARD_TABS.map((tab) => tab.title)).toEqual(["Сводка", "Забеги", "Покупки", "Кошелёк", "Друзья", "Ограничения"]);
  });

  it("вкладка из адреса; нет или чужая — «Сводка»", () => {
    expect(cardTabOf(undefined)).toBe("summary");
    expect(cardTabOf("wallet")).toBe("wallet");
    expect(cardTabOf("x")).toBe("summary");
    expect(cardTabOf("")).toBe("summary");
  });

  it("число на «Покупках» — не выданные; выданные и тестовые «не выдан» не считаются, нулей в ответе нет", () => {
    const card = cardOf({ purchases: [purchase({ purchaseId: "a", fulfilledAt: null }), purchase({ purchaseId: "b" })] });
    expect(tabCounts(card, [])).toEqual({ purchases: 1 });
    expect(tabCounts(cardOf({ purchases: [purchase({ purchaseId: "b" })] }), [])).toEqual({});
  });

  it("число на «Ограничениях» — действующие", () => {
    const card = cardOf();
    expect(tabCounts(card, [restriction("leaderboard"), restriction("all"), restriction("chat", "lifted")])).toEqual({ restrictions: 2 });
  });

  it("без права на выручку числа покупок нет", () => {
    expect(tabCounts(cardOf({ purchases: null }), [])).toEqual({});
  });
});

describe("«Сводка»", () => {
  it("цепочка вех — шесть из девяти", () => {
    expect(MILESTONE_CHAIN.map(([, title]) => title)).toEqual(["Вход", "1-й забег", "5 забегов", "D1", "D7", "Покупка"]);
  });

  it("лучший забег — на самой трудной сложности, где он есть", () => {
    expect(bestRun({ normal: { survivalSec: 300, rank: 5 }, hard: { survivalSec: 120, rank: 9 } })).toEqual({ difficulty: "hard", survivalSec: 120, rank: 9 });
    expect(bestRun({ easy: { survivalSec: 60, rank: 2 }, normal: null, hard: null })).toEqual({ difficulty: "easy", survivalSec: 60, rank: 2 });
    expect(bestRun({ easy: null, normal: null, hard: null })).toBeNull();
    expect(bestRun({})).toBeNull();
  });

  it("незнакомая сложность — после известных", () => {
    expect(bestRun({ nightmare: { survivalSec: 10, rank: 1 }, easy: { survivalSec: 60, rank: 2 } })?.difficulty).toBe("easy");
    expect(bestRun({ nightmare: { survivalSec: 10, rank: 1 }, easy: null })?.difficulty).toBe("nightmare");
  });

  it("цифры: забеги, лучшее, звёзды, возвраты, монеты, самоцветы", () => {
    const card = cardOf({
      runs: { runs: 2, totalKills: 1, totalSurvivalSec: 1, best: { easy: null, normal: { survivalSec: 425, rank: 3 }, hard: null }, recent: [] },
      purchases: [purchase({ purchaseId: "a", chargedStars: 50 }), purchase({ purchaseId: "b", chargedStars: 25 }), purchase({ purchaseId: "t", mode: "test", chargedStars: 99 }), purchase({ purchaseId: "r", chargedStars: 70, refundedAt: AT })],
    });
    const numbers = summaryNumbers(card);
    expect(numbers.map((item) => item.label)).toEqual([
      "забега",
      "лучшее, нормальная · место 3",
      "⭐ всего, 2 покупки",
      "возврат",
      "монет",
      "самоцветов",
    ]);
    expect(numbers.map((item) => item.value)).toEqual(["2", "7:05", "75", "1", "150", "5"]);
  });

  it("тестовая и возвращённая покупки в звёзды не идут", () => {
    const card = cardOf({ purchases: [purchase({ mode: "test", chargedStars: 99 }), purchase({ purchaseId: "r", chargedStars: 70, refundedAt: AT })] });
    expect(summaryNumbers(card).find((item) => item.label.startsWith("⭐"))).toEqual({ value: "0", label: "⭐ всего, 0 покупок" });
  });

  it("склонения: 1 забег, 2 забега, 5 забегов", () => {
    const runs = (n: number) => summaryNumbers(cardOf({ runs: { runs: n, totalKills: 0, totalSurvivalSec: 0, best: {}, recent: [] } }))[0];
    expect(runs(1)).toEqual({ value: "1", label: "забег" });
    expect(runs(2)?.label).toBe("забега");
    expect(runs(5)?.label).toBe("забегов");
    expect(runs(21)?.label).toBe("забег");
  });

  it("без лучшего забега — без цифры «лучшее»", () => {
    expect(summaryNumbers(cardOf()).map((item) => item.label)).not.toContainEqual(expect.stringContaining("лучшее"));
  });

  it("без права на выручку звёзд и возвратов нет", () => {
    const labels = summaryNumbers(cardOf({ purchases: null })).map((item) => item.label);
    expect(labels.some((label) => label.startsWith("⭐"))).toBe(false);
    expect(labels).not.toContain("возвратов");
    expect(labels).toContain("монет");
  });

  it("аккаунт коротко: первые четыре и последние четыре знака", () => {
    expect(shortId("3f2a1b7c9d0e91c0")).toBe("3f2a…91c0");
    expect(shortId(ACCOUNT)).toBe("3f2a…91c0");
    expect(shortId("abc")).toBe("abc");
  });
});

describe("разметка «Сводки»", () => {
  const funnel = { enteredAt: AT, appOpenedAt: AT, firstRunStartedAt: AT, firstRunFinishedAt: null, runsRecorded: 2, runs2At: null, runs5At: null, returnedD1At: null, returnedD7At: null, firstPurchaseAt: null };
  const recent = [{ difficultyId: "normal", survivalSec: 425, level: 7, startingWeaponId: "spark", at: Date.parse(AT) }];
  const html = (card: PlayerCard) => renderToStaticMarkup(createElement(PlayerSummary, { card, onTab: () => undefined }));

  it("шесть цифр, цепочка вех, последние покупки и забеги со ссылками «все →»", () => {
    const out = html(cardOf({ funnel, runs: { runs: 2, totalKills: 1, totalSurvivalSec: 1, best: { normal: { survivalSec: 425, rank: 3 } }, recent }, purchases: [purchase({ purchaseId: "a", fulfilledAt: null })] }));
    for (const title of ["Профиль", "Вехи воронки", "Откуда пришёл", "Последние покупки", "Последние забеги"]) expect(out).toContain(title);
    expect(out.match(/все →/g)).toHaveLength(2);
    expect(out).toContain("не выдан");
    expect(out.match(/<li[^>]*title="[^"]*: /g)).toHaveLength(6);
    expect(out).toContain("1-й забег");
  });

  it("пройденная веха — точкой цвета успеха, непройденная — пустой", () => {
    const out = html(cardOf({ funnel }));
    expect(out).toContain("bg-success");
    expect(out).toContain("bg-surface");
  });

  it("без права на выручку — без покупок, забеги на всю ширину", () => {
    const out = html(cardOf({ purchases: null, runs: { runs: 1, totalKills: 1, totalSurvivalSec: 1, best: {}, recent } }));
    expect(out).not.toContain("Последние покупки");
    expect(out).toContain("Последние забеги");
    expect(out).not.toContain("lg:grid-cols-2");
  });

  it("нет вех и забегов — прежние тексты", () => {
    const out = html(cardOf());
    expect(out).toContain("Вех нет: игрок ни разу не входил.");
    expect(out).toContain("Забегов нет");
    expect(out).toContain("Покупок нет");
  });
});
