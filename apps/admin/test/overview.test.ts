import { describe, expect, it } from "vitest";
import { dayTitle, fetchOverview, newAccounts, sourcesLine, versusYesterday, type OverviewDay } from "../src/api/overview";
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
    expect(versusYesterday(125, 100)).toEqual({ text: "+25% к вчера", tone: "up" });
    expect(versusYesterday(90, 100)).toEqual({ text: "−10% к вчера", tone: "down" });
    expect(versusYesterday(100, 100)).toEqual({ text: "как вчера", tone: "flat" });
    expect(versusYesterday(0, 0)).toEqual({ text: "как вчера", tone: "flat" });
    expect(versusYesterday(7, 0)).toEqual({ text: "вчера к этому часу — 0", tone: "up" });
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
    const overview = { day: "2026-10-01", from: "2026-09-30T21:00:00.000Z", at: "2026-10-01T18:30:00.000Z", today: DAY, yesterday: DAY, series: [{ day: "2026-10-01", newAccounts: 14, active: 40, finishedRuns: 120, stars: null }], attention: [] };
    const { fetch, calls } = fakeFetch(json(200, { data: overview }));
    const result = await fetchOverview(new AdminApi(fetch));
    expect(result.ok && result.data.today.revenue).toBeNull();
    expect(calls[0]?.url).toBe("/api/v1/admin/overview");
  });
});
