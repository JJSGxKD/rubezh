import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchFunnel, funnelReportSchema, funnelTotal, periodFromDates, platformTitle, shareOfAccounts, touchOf, type FunnelRow } from "../src/api/funnel";
import { fetchReviewQueue } from "../src/api/review";
import { fakeFetch, json } from "./helpers";

const ROW: FunnelRow = {
  platform: "telegram",
  startKind: "click",
  startRef: "launch",
  startSource: "tg_ads",
  accounts: 40,
  entered: 32,
  appOpened: 38,
  firstRunStarted: 30,
  firstRunFinished: 25,
  runs2: 20,
  runs5: 9,
  returnedD1: 12,
  returnedD7: 4,
  firstPurchase: 1,
};

describe("воронка", () => {
  it("день «по» входит в период целиком, пустые поля — умолчание сервера", () => {
    const period = periodFromDates("2026-09-01", "2026-09-25");
    expect(new Date(period.from ?? "").getDate()).toBe(1);
    // Граница — полночь следующего дня по местному времени.
    const to = new Date(period.to ?? "");
    expect([to.getDate(), to.getHours()]).toEqual([26, 0]);
    expect(periodFromDates("", "")).toEqual({ from: undefined, to: undefined });
    expect(periodFromDates("25.09.2026", "")).toEqual({ from: undefined, to: undefined });
  });

  it("итог складывает строки, доля — от аккаунтов строки, даже если в бота не входили", () => {
    const total = funnelTotal([ROW, { ...ROW, startKind: "organic", startRef: null, startSource: null, accounts: 10, entered: 10, firstPurchase: 0 }]);
    expect(total).toMatchObject({ platform: "все", accounts: 50, entered: 42, firstPurchase: 1 });
    expect(shareOfAccounts(ROW, "runs2")).toBe(50);
    // По ссылке кампании игра открывается мимо бота — доля всё равно есть.
    expect(shareOfAccounts({ ...ROW, entered: 0 }, "appOpened")).toBe(95);
    expect(shareOfAccounts({ ...ROW, accounts: 0 }, "runs2")).toBeNull();
  });

  it("откуда пришли — словами: кампания с источником, удалённая ссылка, итог, незнакомое", () => {
    expect(touchOf(ROW)).toEqual({ title: "Кампания «launch»", detail: "источник: tg_ads" });
    expect(touchOf({ ...ROW, startRef: null }).title).toBe("Ссылка кампании");
    expect(touchOf({ ...ROW, startKind: "invite", startRef: null }).title).toBe("Приглашение друга");
    expect(touchOf({ ...ROW, startKind: "notification", startRef: "friend_request" })).toEqual({ title: "Кнопка уведомления в боте", detail: "friend_request" });
    expect(touchOf(funnelTotal([ROW])).title).toBe("Все источники");
    expect(touchOf({ ...ROW, startKind: "new_kind", startRef: "x" })).toEqual({ title: "new_kind", detail: "x" });
    expect(platformTitle("telegram")).toBe("Telegram");
    expect(platformTitle("все")).toBe("все");
  });

  it("период уходит в запросе, отчёт разбирается схемой", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-26T00:00:00.000Z", rows: [ROW] } }));
    const result = await fetchFunnel(new AdminApi(fetch), { from: "2026-09-01T00:00:00.000Z" });
    expect(result.ok && result.data.rows).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/v1/admin/funnel?from=2026-09-01T00%3A00%3A00.000Z");
    expect(funnelReportSchema.safeParse({ from: "x", to: "y", rows: [{ ...ROW, entered: "40" }] }).success).toBe(false);
  });
});

describe("разбор забегов", () => {
  it("просит всю очередь, которую отдаёт сервер", async () => {
    const run = { runId: "r1", accountId: "a1", verdict: "suspicious", verdictReasons: ["kills_rate"], difficulty: "easy", survivalSec: 600, level: 20, enemiesKilled: 900, finishedAt: "2026-09-25T10:00:00.000Z" };
    const { fetch, calls } = fakeFetch(json(200, { data: { runs: [run] } }));
    const result = await fetchReviewQueue(new AdminApi(fetch));
    expect(result.ok && result.data.runs[0]?.verdictReasons).toEqual(["kills_rate"]);
    expect(calls[0]?.url).toBe("/api/v1/admin/runs/review?limit=200");
  });
});
