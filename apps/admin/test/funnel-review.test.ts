import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchFunnel, funnelReportSchema, funnelTotal, periodFromDates, shareOfEntered, type FunnelRow } from "../src/api/funnel";
import { fetchReviewQueue } from "../src/api/review";
import { fakeFetch, json } from "./helpers";

const ROW: FunnelRow = {
  platform: "telegram",
  startKind: "click",
  startRef: "ch-launch",
  accounts: 40,
  entered: 40,
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

  it("итог складывает строки, доля считается от вошедших и не делит на ноль", () => {
    const total = funnelTotal([ROW, { ...ROW, startKind: "organic", startRef: null, accounts: 10, entered: 10, firstPurchase: 0 }]);
    expect(total).toMatchObject({ platform: "все", accounts: 50, entered: 50, firstPurchase: 1 });
    expect(shareOfEntered(ROW, "runs2")).toBe(50);
    expect(shareOfEntered({ ...ROW, entered: 0 }, "runs2")).toBeNull();
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
