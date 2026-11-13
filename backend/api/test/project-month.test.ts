import { Decimal } from "@bh/fx";
import { describe, expect, it } from "vitest";
import { monthsFromFirst, nextMonth, projectMonth, type ProjectMonthRate, type PurchaseRow } from "../src/modules/stakeholders/project-month.js";

/**
 * Месяц проекта для кабинета участника (docs/35-stage4-plan.md Р218, tasks/T-0453): чистые расчёты без Nest и
 * Prisma — выручка живыми оплатами без возвращённых, холд, деньги вниз до цента и копейки, черновик части.
 */

const DAY_MS = 86_400_000;
const NOW = new Date(Date.UTC(2026, 10, 25, 12));
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

/** Курс выплаты звезды 0,013 $ и 90 ₽ за доллар. */
const RATES: ProjectMonthRate = { starUsd: new Decimal("0.013"), usdRub: new Decimal("90") };

function row(patch: Partial<PurchaseRow> = {}): PurchaseRow {
  return { chargedStars: 100, paidAt: daysAgo(30), refundedAt: null, product: "shop_item", platform: "telegram", ...patch };
}

const month = (purchases: readonly PurchaseRow[], options: { holdDays?: number; rates?: ProjectMonthRate | null; shareBp?: number | null } = {}) =>
  projectMonth({ purchases, holdDays: options.holdDays ?? 21, now: NOW, rates: options.rates === undefined ? RATES : options.rates, shareBp: options.shareBp === undefined ? null : options.shareBp });

describe("месяц проекта: пустой и возвраты", () => {
  it("пусто — нули, холд пуст, ближайшего выхода нет, черновика нет", () => {
    const result = month([]);

    expect(result.revenue.stars).toEqual({ paid: 0, refunded: 0, net: 0 });
    expect(result.revenue.byPlatform).toEqual([]);
    expect(result.revenue.bySource).toEqual([]);
    expect(result.revenue.usd).toBe("0.00");
    expect(result.revenue.rub).toBe("0.00");
    expect(result.hold).toEqual({ days: 21, inHoldStars: 0, releasedStars: 0, nextReleaseAt: null });
    expect(result.draft).toBeNull();
  });

  it("оплата и её возврат — в refunded, в net и в холде их нет", () => {
    const result = month([row({ chargedStars: 300, paidAt: daysAgo(5), refundedAt: daysAgo(1) }), row({ chargedStars: 700, paidAt: daysAgo(5) })]);

    expect(result.revenue.stars).toEqual({ paid: 1_000, refunded: 300, net: 700 });
    expect(result.hold.inHoldStars).toBe(700);
    expect(result.hold.releasedStars).toBe(0);
    expect(result.revenue.byPlatform).toEqual([{ platform: "telegram", net: 700 }]);
  });

  it("месяц из одних возвратов — net ноль, площадок и источников нет", () => {
    const result = month([row({ chargedStars: 50, refundedAt: daysAgo(2) })]);

    expect(result.revenue.stars).toEqual({ paid: 50, refunded: 50, net: 0 });
    expect(result.revenue.byPlatform).toEqual([]);
    expect(result.revenue.bySource).toEqual([]);
    expect(result.hold.nextReleaseAt).toBeNull();
  });
});

describe("месяц проекта: холд", () => {
  it("оплата 20 дней назад при холде 21 — в холде, выход через день; 22 дня назад — вышла", () => {
    const inHold = month([row({ chargedStars: 40, paidAt: daysAgo(20) })]);
    expect(inHold.hold).toEqual({ days: 21, inHoldStars: 40, releasedStars: 0, nextReleaseAt: new Date(NOW.getTime() + DAY_MS).toISOString() });

    const released = month([row({ chargedStars: 40, paidAt: daysAgo(22) })]);
    expect(released.hold).toEqual({ days: 21, inHoldStars: 0, releasedStars: 40, nextReleaseAt: null });
  });

  it("ровно через холд оплата уже вышла, а выход выбирается самый ранний из тех, что ещё в холде", () => {
    const result = month([
      row({ chargedStars: 10, paidAt: daysAgo(21) }),
      row({ chargedStars: 20, paidAt: daysAgo(15) }),
      row({ chargedStars: 30, paidAt: daysAgo(3) }),
    ]);

    expect(result.hold.releasedStars).toBe(10);
    expect(result.hold.inHoldStars).toBe(50);
    expect(result.hold.nextReleaseAt).toBe(new Date(daysAgo(15).getTime() + 21 * DAY_MS).toISOString());
  });

  it("холд 0 дней — всё выпущено сразу, держать нечего", () => {
    const result = month([row({ chargedStars: 25, paidAt: daysAgo(0) })], { holdDays: 0 });

    expect(result.hold).toEqual({ days: 0, inHoldStars: 0, releasedStars: 25, nextReleaseAt: null });
  });
});

describe("месяц проекта: площадки и источники", () => {
  it("делит по площадке аккаунта и по виду покупки, донат — «Донаты», без нулевых, по убыванию", () => {
    const result = month([
      row({ chargedStars: 500, platform: "telegram", product: "shop_item" }),
      row({ chargedStars: 200, platform: "vk", product: "continue_run" }),
      row({ chargedStars: 300, platform: "vk", product: "vip" }),
      row({ chargedStars: 150, platform: "telegram", product: "donation" }),
      row({ chargedStars: 999, platform: "max", product: "shop_item", refundedAt: daysAgo(1) }),
    ]);

    expect(result.revenue.byPlatform).toEqual([
      { platform: "telegram", net: 650 },
      { platform: "vk", net: 500 },
    ]);
    expect(result.revenue.bySource).toEqual([
      { source: "shop", net: 500 },
      { source: "vip", net: 300 },
      { source: "continue", net: 200 },
      { source: "donation", net: 150 },
    ]);
    expect(result.revenue.stars.net).toBe(1_150);
  });
});

describe("месяц проекта: деньги и черновик части", () => {
  it("оплачено 10 000 ⭐, возвращено 300 ⭐ — чистая 9 700, 126,10 $ по 0,013; доля 25 % — 31,52 $ и 2 425 ⭐", () => {
    const result = month([row({ chargedStars: 9_700 }), row({ chargedStars: 300, refundedAt: daysAgo(2) })], { shareBp: 2_500 });

    expect(result.revenue.stars).toEqual({ paid: 10_000, refunded: 300, net: 9_700 });
    expect(result.revenue.usd).toBe("126.10");
    expect(result.revenue.rub).toBe("11349.00");
    // 126,10 × 0,25 = 31,525 $ — вниз до цента; рубли — от точных 31,525
    expect(result.draft).toEqual({ sharePercent: 25, usd: "31.52", rub: "2837.25", stars: 2_425 });
  });

  it("доля 33,33 % от 126,10 $ — 42,02 $: 42,029… округляется вниз, а не к ближайшему", () => {
    const result = month([row({ chargedStars: 9_700 })], { shareBp: 3_333 });

    expect(result.draft?.usd).toBe("42.02");
    expect(result.draft?.sharePercent).toBe(33.33);
    // 9700 × 3333 / 10000 = 3233,01 ⭐ — вниз
    expect(result.draft?.stars).toBe(3_233);
  });

  it("рубли — вниз до копейки от точного значения, а не от уже округлённых долларов", () => {
    // 3 ⭐ × 0,013 = 0,039 $ → 0,03 $; 0,039 × 91,7 = 3,5763 ₽ → 3,57 (от 0,03 вышло бы 2,75)
    const result = month([row({ chargedStars: 3 })], { rates: { starUsd: new Decimal("0.013"), usdRub: new Decimal("91.7") } });

    expect(result.revenue.usd).toBe("0.03");
    expect(result.revenue.rub).toBe("3.57");
  });

  it("курса нет — суммы null, звёзды и черновик в звёздах есть", () => {
    const result = month([row({ chargedStars: 1_000 })], { rates: null, shareBp: 1_000 });

    expect(result.revenue.stars.net).toBe(1_000);
    expect(result.revenue.usd).toBeNull();
    expect(result.revenue.rub).toBeNull();
    expect(result.draft).toEqual({ sharePercent: 10, usd: null, rub: null, stars: 100 });
  });

  it("доли нет — черновика нет; нулевая доля — тоже", () => {
    expect(month([row()], { shareBp: null }).draft).toBeNull();
    expect(month([row()], { shareBp: 0 }).draft).toBeNull();
  });
});

describe("месяц проекта: календарь", () => {
  it("nextMonth переходит через конец года", () => {
    expect(nextMonth("2026-11")).toBe("2026-12");
    expect(nextMonth("2026-12")).toBe("2027-01");
  });

  it("monthsFromFirst — от текущего к первому, новые сверху; первый позже текущего — один текущий", () => {
    expect(monthsFromFirst("2026-09", "2026-11")).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(monthsFromFirst("2025-12", "2026-02")).toEqual(["2026-02", "2026-01", "2025-12"]);
    expect(monthsFromFirst("2026-11", "2026-11")).toEqual(["2026-11"]);
    expect(monthsFromFirst("2027-01", "2026-11")).toEqual(["2026-11"]);
  });
});
