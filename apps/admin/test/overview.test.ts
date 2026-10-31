import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdsPanel, FunnelBars } from "../src/screens/overview/overview-parts";
import {
  completionPct,
  dayTitle,
  fetchOverview,
  funnelBars,
  LOW_COMPLETION_PCT,
  networkShares,
  newAccounts,
  networkTitle,
  overviewSchema,
  parsePeriod,
  passLine,
  periodTitle,
  shiftDay,
  sourcesLine,
  versusBefore,
  type OverviewDay,
} from "../src/api/overview";
import { AdminApi } from "../src/api/client";
import { formatNumber } from "../src/format";
import { fakeFetch, json } from "./helpers";

const DAY: OverviewDay = {
  accounts: { organic: 2, click: 12, friend: 0 },
  active: 40,
  sessions: 90,
  runs: { finished: 120, players: 30, medianSurvivalSec: 410 },
  revenue: null,
  funnel: { entered: 10, appOpened: 9, firstRun: 8, runs5: 2, returnedD1: 5, returnedD7: 1, firstPurchase: 1 },
};

describe("сводка", () => {
  it("сравнение со вчера к тому же часу: проценты, ровно, от нуля — без «бесконечности»", () => {
    expect(versusBefore(125, 100)).toEqual({ text: "+25% к вчера", tone: "up" });
    expect(versusBefore(90, 100)).toEqual({ text: "−10% к вчера", tone: "down" });
    expect(versusBefore(100, 100)).toEqual({ text: "как вчера", tone: "flat" });
    expect(versusBefore(0, 0)).toEqual({ text: "как вчера", tone: "flat" });
    expect(versusBefore(7, 0)).toEqual({ text: "вчера к этому часу — 0", tone: "up" });
  });

  it("новые игроки — суммой и словами по источникам, крупные первыми, нули не показываются", () => {
    expect(newAccounts(DAY)).toBe(14);
    expect(sourcesLine(DAY)).toBe(`ссылки ${formatNumber(12)} · органика 2`);
    expect(sourcesLine({ ...DAY, accounts: {} })).toBe("пока никого");
  });

  it("сутки — из строки сервера по-московски, а не из времени браузера", () => {
    expect(dayTitle("2026-10-01")).toBe("1 октября");
    expect(dayTitle("2027-01-31")).toBe("31 января");
  });

  it("ответ разбирается схемой: выручка может быть закрыта", async () => {
    const overview = { day: "2026-10-01", from: "2026-09-30T21:00:00.000Z", at: "2026-10-01T18:30:00.000Z", today: DAY, yesterday: DAY, series: [{ day: "2026-10-01", newAccounts: 14, active: 40, finishedRuns: 120, stars: null, purchases: null, adsCompleted: 0 }], attention: [], ads: null, days: 1 };
    const { fetch, calls } = fakeFetch(json(200, { data: overview }));
    const result = await fetchOverview(new AdminApi(fetch), 1);
    expect(result.ok && result.data.today.revenue).toBeNull();
    expect(calls[0]?.url).toBe("/api/v1/admin/overview?days=1");
  });
});

const FUNNEL: OverviewDay["funnel"] = { entered: 240, appOpened: 198, firstRun: 171, runs5: 96, returnedD1: 64, returnedD7: 22, firstPurchase: 9 };

describe("сводка: реклама", () => {
  it("доля досмотра — целым процентом от показанных; показов нет — null", () => {
    expect(completionPct({ shown: 0, completed: 0 })).toBeNull();
    expect(completionPct({ shown: 744, completed: 610 })).toBe(82);
    expect(completionPct({ shown: 3, completed: 1 })).toBe(33);
    expect(LOW_COMPLETION_PCT).toBe(60);
  });

  it("доли сетей — целыми процентами, сумма всегда 100", () => {
    const shares = networkShares([
      { networkKey: "adsgram", completed: 1516 },
      { networkKey: "taddy", completed: 706 },
      { networkKey: "richads", completed: 392 },
    ]);
    expect(shares.map((share) => share.networkKey)).toEqual(["adsgram", "taddy", "richads"]);
    expect(shares.reduce((sum, share) => sum + share.pct, 0)).toBe(100);
    expect(shares.map((share) => share.pct)).toEqual([58, 27, 15]);
  });

  it("доли, которые не делятся поровну, всё равно дают 100", () => {
    const shares = networkShares([
      { networkKey: "a", completed: 1 },
      { networkKey: "b", completed: 1 },
      { networkKey: "c", completed: 1 },
    ]);
    expect(shares.reduce((sum, share) => sum + share.pct, 0)).toBe(100);
  });

  it("сетей нет — пусто; досмотров нет — нули без деления на ноль", () => {
    expect(networkShares([])).toEqual([]);
    expect(networkShares([{ networkKey: "a", completed: 0 }])).toEqual([{ networkKey: "a", pct: 0 }]);
  });

  it("сеть — по ключу сервера: известные именем, незнакомая — самим ключом", () => {
    expect(networkTitle("adsgram")).toBe("AdsGram");
    expect(networkTitle("adsonar")).toBe("AdSonar");
    expect(networkTitle("richads")).toBe("RichAds");
    expect(networkTitle("taddy")).toBe("Taddy");
    expect(networkTitle("newnet")).toBe("newnet");
  });

  it("ответ без рекламы и без выручки разбирается; сервер старее панели — тоже", () => {
    const base = { day: "2026-10-07", from: "2026-10-06T21:00:00.000Z", at: "2026-10-07T12:00:00.000Z", today: DAY, yesterday: DAY, attention: [] };
    const withoutAds = overviewSchema.parse({ ...base, days: 7, ads: null, series: [{ day: "2026-10-07", newAccounts: 1, active: 1, finishedRuns: 1, stars: null, purchases: null, adsCompleted: 5 }] });
    expect(withoutAds.ads).toBeNull();
    expect(withoutAds.series[0]?.purchases).toBeNull();
    const old = overviewSchema.parse({ ...base, series: [{ day: "2026-10-07", newAccounts: 1, active: 1, finishedRuns: 1, stars: 3 }] });
    expect(old.days).toBe(1);
    expect(old.ads).toBeNull();
    expect(old.series[0]).toMatchObject({ purchases: null, adsCompleted: 0 });
  });

  it("пропуск VIP: строка в плитке только при их наличии; в схеме без поля — ноль", () => {
    expect(passLine(0)).toBeNull();
    expect(passLine(25)).toBe("пропусков VIP 25");
    const totals = { offered: 10, shown: 9, completed: 8, claimed: 7, failed: 1 };
    const overview = overviewSchema.parse({
      day: "2026-10-07",
      from: "2026-10-06T21:00:00.000Z",
      at: "2026-10-07T12:00:00.000Z",
      today: DAY,
      yesterday: DAY,
      attention: [],
      series: [{ day: "2026-10-07", newAccounts: 1, active: 1, finishedRuns: 1, stars: 1, purchases: 1, adsCompleted: 5 }],
      ads: { now: { ...totals, passed: 4 }, before: totals, places: [{ place: "wheel_spin", ...totals }], networks: [] },
    });
    expect(overview.ads?.now.passed).toBe(4);
    expect(overview.ads?.before.passed).toBe(0);
    expect(overview.ads?.places[0]?.passed).toBe(0);
    expect(overview.series[0]?.adsPassed).toBe(0);
  });

  it("ответ с рекламой: итоги, места и сети", () => {
    const totals = { offered: 10, shown: 9, completed: 8, claimed: 7, failed: 1 };
    const overview = overviewSchema.parse({
      day: "2026-10-07",
      from: "2026-10-06T21:00:00.000Z",
      at: "2026-10-07T12:00:00.000Z",
      days: 30,
      today: DAY,
      yesterday: DAY,
      attention: [],
      series: [],
      ads: { now: totals, before: totals, places: [{ place: "second_chance", ...totals }], networks: [{ networkKey: "adsgram", completed: 8 }] },
    });
    expect(overview.ads?.places[0]?.place).toBe("second_chance");
    expect(overview.days).toBe(30);
  });
});

describe("сводка: вехи полосами и период", () => {
  it("доля от первой вехи и от прошлой: 240, 198, 171", () => {
    const bars = funnelBars(FUNNEL);
    expect(bars).toHaveLength(7);
    expect(bars.map((bar) => bar.count).slice(0, 3)).toEqual([240, 198, 171]);
    expect(bars.map((bar) => bar.ofFirst).slice(0, 3)).toEqual([1, 0.825, 0.7125]);
    expect(bars.map((bar) => bar.ofPrev).slice(0, 3)).toEqual([null, 83, 86]);
    expect(bars[0]?.title).toBe("Вошли в бота");
    expect(bars[6]?.title).toBe("Первая покупка");
  });

  it("никто не вошёл — доли нули, без деления на ноль", () => {
    const bars = funnelBars({ entered: 0, appOpened: 0, firstRun: 0, runs5: 0, returnedD1: 0, returnedD7: 0, firstPurchase: 0 });
    expect(bars.every((bar) => bar.ofFirst === 0)).toBe(true);
    expect(bars.slice(1).every((bar) => bar.ofPrev === 0)).toBe(true);
  });

  it("сдвиг суток по календарю, через границу месяца и года", () => {
    expect(shiftDay("2026-10-07", -6)).toBe("2026-10-01");
    expect(shiftDay("2026-10-01", -1)).toBe("2026-09-30");
    expect(shiftDay("2027-01-02", -6)).toBe("2026-12-27");
  });

  it("заголовок периода: сегодня, неделя и месяц", () => {
    expect(periodTitle(1, "2026-10-07", "2026-10-07")).toBe("Сегодня, 7 октября — с полуночи по Москве");
    expect(periodTitle(7, "2026-10-01", "2026-10-07")).toBe("7 дней — с 1 по 7 октября");
    expect(periodTitle(7, "2026-09-28", "2026-10-04")).toBe("7 дней — с 28 сентября по 4 октября");
    expect(periodTitle(30, "2026-09-08", "2026-10-07")).toBe("30 дней — с 8 сентября по 7 октября");
  });

  it("выбранный период читается из хранилища; мусор и пусто — сутки", () => {
    expect(parsePeriod("7")).toBe(7);
    expect(parsePeriod("30")).toBe(30);
    expect(parsePeriod("1")).toBe(1);
    expect(parsePeriod("14")).toBe(1);
    expect(parsePeriod("abc")).toBe(1);
    expect(parsePeriod(null)).toBe(1);
  });

  it("запрос уходит с периодом", async () => {
    const overview = { day: "2026-10-07", from: "2026-10-06T21:00:00.000Z", at: "2026-10-07T12:00:00.000Z", today: DAY, yesterday: DAY, series: [], attention: [], ads: null, days: 7 };
    const { fetch, calls } = fakeFetch(json(200, { data: overview }));
    await fetchOverview(new AdminApi(fetch), 7);
    expect(calls[0]?.url).toBe("/api/v1/admin/overview?days=7");
  });

  it("сравнение с прошлым окном называет окно: вчера, 7 или 30 дней", () => {
    expect(versusBefore(125, 100, 7).text).toBe("+25% к прошлым 7 дням");
    expect(versusBefore(90, 100, 30).text).toBe("−10% к прошлым 30 дням");
    expect(versusBefore(100, 100, 7).tone).toBe("flat");
    expect(versusBefore(5, 0, 7)).toEqual({ text: "в прошлые 7 дней — 0", tone: "up" });
  });
});

describe("сводка: разметка рекламы и вех", () => {
  const totals = (shown: number, completed: number, passed = 0) => ({ offered: shown + 5, shown, completed, claimed: completed - 2, failed: 3, passed });
  const ads = {
    now: totals(1000, 700, 25),
    before: totals(900, 600),
    places: [
      { place: "second_chance", ...totals(744, 610, 20) },
      { place: "interstitial", ...totals(100, 40, 5) },
    ],
    networks: [
      { networkKey: "adsgram", completed: 600 },
      { networkKey: "taddy", completed: 100 },
    ],
  };

  it("места — подписями, итог последней строкой, доля ниже порога — предупреждением", () => {
    const html = renderToStaticMarkup(createElement(AdsPanel, { ads, days: 7 }));
    expect(html).toContain("Реклама за 7 дней");
    expect(html).toContain("Второй шанс");
    expect(html.indexOf("Всего")).toBeGreaterThan(html.indexOf("Между забегами"));
    expect(html).toContain("82%");
    expect(html).toMatch(/badge-tinted[^>]*>40%</);
    expect(html).not.toMatch(/badge-tinted[^>]*>82%</);
  });

  it("доли сетей и пометка про «Между забегами»", () => {
    const html = renderToStaticMarkup(createElement(AdsPanel, { ads, days: 1 }));
    expect(html).toContain("Реклама сегодня");
    expect(html).toContain("AdsGram");
    expect(html).toContain("86%");
    expect(html).toContain("14%");
    expect(html).toContain("«Между забегами» наград нет");
    expect(html).toContain("В раздел «Реклама»");
  });

  it("пропуск VIP — колонкой по месту и суммой в «Всего», с пометкой под таблицей", () => {
    const html = renderToStaticMarkup(createElement(AdsPanel, { ads, days: 7 }));
    expect(html).toContain("Пропуск VIP");
    expect(html).toContain("Пропуск VIP — награда без ролика у игроков с VIP. В досмотры, доли и сети не входит.");
    // В «Всего» — сумма пропусков окна; доля досмотра их не знает: 700 / 1000 = 70%.
    expect(html).toContain("25");
    expect(html).toContain("70%");
  });

  it("пропусков нет — ни колонки, ни пометки", () => {
    const quiet = { ...ads, now: { ...ads.now, passed: 0 }, places: ads.places.map((place) => ({ ...place, passed: 0 })) };
    const html = renderToStaticMarkup(createElement(AdsPanel, { ads: quiet, days: 7 }));
    expect(html).not.toContain("Пропуск VIP");
  });

  it("показов за период не было — пустой текст вместо таблицы", () => {
    const zero = { offered: 0, shown: 0, completed: 0, claimed: 0, failed: 0, passed: 0 };
    const html = renderToStaticMarkup(createElement(AdsPanel, { ads: { now: zero, before: zero, places: [], networks: [] }, days: 1 }));
    expect(html).toContain("Показов за период не было");
    expect(html).not.toContain("<table");
  });

  it("вехи: семь полос, у первой «—», у остальных доля от прошлого", () => {
    const html = renderToStaticMarkup(createElement(FunnelBars, { funnel: FUNNEL }));
    expect(html.match(/role="img"/g)).toHaveLength(7);
    expect(html).toContain("Вошли в бота");
    expect(html).toContain("83% от прошлого");
    expect(html).toContain("86% от прошлого");
    expect(html).toContain("—");
  });
});
