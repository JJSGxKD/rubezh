import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { myProjectSchema, monthTitle, moneyLine, type MyProject } from "../src/api/my-project";
import { MyProjectContent } from "../src/screens/my-project/MyProjectScreen";

/**
 * Кабинет «Мой проект» (tasks/T-0455, Р218): разбор ответа сервера и блоки экрана по ролям.
 */

const BASE: MyProject = {
  month: "2026-11",
  months: ["2026-11", "2026-10"],
  viewer: { role: "stakeholder", sharePercent: 25, shareFrom: "2026-11" },
  participants: [
    { name: "Анна", sharePercent: 25, me: true },
    { name: "Борис", sharePercent: 5, me: false },
  ],
  ownerSharePercent: 70,
  rates: { starUsd: "0.013", usdRub: "92.40", at: "2026-11-13T09:00:00.000Z" },
  project: {
    revenue: {
      stars: { paid: 10_000, refunded: 300, net: 9_700 },
      byPlatform: [
        { platform: "telegram", net: 9_000 },
        { platform: "vk", net: 700 },
      ],
      bySource: [
        { source: "shop", net: 6_000 },
        { source: "continue", net: 2_000 },
        { source: "vip", net: 1_000 },
        { source: "donation", net: 700 },
      ],
      usd: "126.10",
      rub: "11651.64",
    },
    hold: { days: 21, inHoldStars: 4_000, releasedStars: 5_700, nextReleaseAt: "2026-12-14T10:00:00.000Z" },
    draft: { sharePercent: 25, usd: "31.52", rub: "2912.91", stars: 2_425 },
  },
};

const plain = (text: string) => text.replace(/[  ]/g, " ");

function html(data: MyProject): string {
  return plain(renderToStaticMarkup(createElement(MyProjectContent, { data, onMonth: () => undefined })));
}

describe("ответ сервера", () => {
  it("разбирается схемой", () => {
    expect(myProjectSchema.parse(BASE).project.revenue.usd).toBe("126.10");
  });

  it("курсы и черновик могут быть null", () => {
    const parsed = myProjectSchema.parse({
      ...BASE,
      rates: null,
      viewer: { role: "finance", sharePercent: null, shareFrom: null },
      project: { ...BASE.project, draft: null, revenue: { ...BASE.project.revenue, usd: null, rub: null } },
    });
    expect(parsed.rates).toBeNull();
    expect(parsed.project.draft).toBeNull();
  });

  it("мусор отклоняется", () => {
    expect(myProjectSchema.safeParse({ month: 5 }).success).toBe(false);
  });
});

describe("подписи", () => {
  it("месяц — «ноябрь 2026»", () => {
    expect(monthTitle("2026-11")).toBe("ноябрь 2026");
  });

  it("деньги — с запятой и разрядами", () => {
    expect(plain(moneyLine("11651.64", "₽"))).toBe("11 651,64 ₽");
    expect(plain(moneyLine("126.10", "$"))).toBe("126,10 $");
  });
});

describe("экран по ролям", () => {
  it("участник: доля, выручка, холд, черновик, участники и курс", () => {
    const text = html(BASE);
    expect(text).toContain("25 % с ноября 2026");
    expect(text).toContain("126,10 $");
    expect(text).toContain("11 651,64 ₽");
    expect(text).toContain("9 700 ⭐");
    expect(text).toContain("Магазин");
    expect(text).toContain("Второй шанс");
    expect(text).toContain("VIP");
    expect(text).toContain("Донаты");
    expect(text).toContain("Возвращено — 300 ⭐");
    expect(text).toContain("В холде — 4 000 ⭐");
    expect(text).toContain("через 21 день после оплаты");
    expect(text).toContain("31,52 $");
    expect(text).toContain("вы");
    expect(text).toContain("Владелец — 70 %");
    expect(text).toContain("1 ⭐ = 0,013 $");
    expect(text).toContain("1 $ = 92,40 ₽");
  });

  it("плашка черновика стоит перед суммой части", () => {
    const text = html(BASE);
    const note = text.indexOf("Черновик: до расходов, налога и займа");
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(text.indexOf("31,52 $"));
  });

  it("текущий месяц подписан «месяц ещё идёт»", () => {
    expect(html({ ...BASE, month: "2026-11" })).toContain("месяц ещё идёт");
    expect(html({ ...BASE, month: "2026-10" })).not.toContain("месяц ещё идёт");
  });

  it("владелец: остаток после участников", () => {
    const text = html({ ...BASE, viewer: { role: "owner", sharePercent: 70, shareFrom: null } });
    expect(text).toContain("Остаток после участников — 70 %");
  });

  it("финансы: без блоков «Моя доля» и «Черновик»", () => {
    const text = html({ ...BASE, viewer: { role: "finance", sharePercent: null, shareFrom: null }, project: { ...BASE.project, draft: null } });
    expect(text).not.toContain("Моя доля");
    expect(text).not.toContain("Черновик");
    expect(text).toContain("Участники");
  });

  it("участник без доли: «Доля ещё не назначена», черновика нет", () => {
    const text = html({ ...BASE, viewer: { role: "stakeholder", sharePercent: 0, shareFrom: null }, project: { ...BASE.project, draft: null } });
    expect(text).toContain("Доля ещё не назначена");
    expect(text).not.toContain("Черновик");
  });

  it("без курсов — суммы в звёздах и подпись про «Курсы»", () => {
    const text = html({
      ...BASE,
      rates: null,
      project: {
        ...BASE.project,
        revenue: { ...BASE.project.revenue, usd: null, rub: null },
        draft: { sharePercent: 25, usd: null, rub: null, stars: 2_425 },
      },
    });
    expect(text).toContain("9 700 ⭐");
    expect(text).toContain("2 425 ⭐");
    expect(text).toContain("Курса выплаты звезды нет");
    expect(text).toContain("«Курсы»");
    expect(text).not.toContain(" $");
  });

  it("пустой месяц: «В этом месяце оплат не было»", () => {
    const empty = { ...BASE.project, revenue: { stars: { paid: 0, refunded: 0, net: 0 }, byPlatform: [], bySource: [], usd: "0.00", rub: "0.00" } };
    expect(html({ ...BASE, project: empty })).toContain("В этом месяце оплат не было");
  });
});
