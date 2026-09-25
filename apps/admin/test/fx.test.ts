import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchFxOverview, manualRateProblem, setManualRate, type ManualRateInput } from "../src/api/fx";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const AT = "2026-09-25T10:00:00.000Z";

const MANUAL: ManualRateInput = { currency: "XTR", purpose: "price", price: "0.013", quote: "USD", expiresInDays: 30, note: "курс Fragment" };

describe("курсы", () => {
  it("обзор разбирается, числа курсов остаются строками", async () => {
    const overview = {
      enabled: true,
      rates: [{ currency: "RUB", usdPerUnit: "0.0123456789", unitsPerUsd: "81.00000001", sources: ["cbr"], observedAt: AT, freshness: "fresh" }],
      missing: ["GRAM"],
      manual: [],
      sources: [{ source: "cbr", tariff: "free", month: "2026-09", used: 12, pausedUntil: null, nextPollAt: AT }],
    };
    const result = await fetchFxOverview(new AdminApi(fakeFetch(json(200, { data: overview })).fetch));
    expect(result.ok && result.data.rates[0]?.usdPerUnit).toBe("0.0123456789");
  });

  it("форма заданного курса — те же границы, что у сервера", () => {
    expect(manualRateProblem(MANUAL)).toBeNull();
    expect(manualRateProblem({ ...MANUAL, price: "0,013" })).not.toBeNull();
    expect(manualRateProblem({ ...MANUAL, price: "0.000" })).not.toBeNull();
    expect(manualRateProblem({ ...MANUAL, price: "-1" })).not.toBeNull();
    expect(manualRateProblem({ ...MANUAL, expiresInDays: 0 })).not.toBeNull();
    expect(manualRateProblem({ ...MANUAL, expiresInDays: 91 })).not.toBeNull();
    expect(manualRateProblem({ ...MANUAL, note: "  " })).not.toBeNull();
  });

  it("заданный курс уходит телом с заголовком панели", async () => {
    const saved = { ...MANUAL, usdPerUnit: "0.013", sources: ["manual"], observedAt: AT, freshness: "fresh", setBy: "owner", expiresAt: AT };
    const { fetch, calls } = fakeFetch(json(200, { data: saved }));
    const result = await setManualRate(new AdminApi(fetch), MANUAL);
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/v1/admin/fx/manual");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(MANUAL);
  });
});

describe("меню", () => {
  it("раздел — за правом его маршрутов на сервере", () => {
    expect(SECTIONS.find((section) => section.id === "fx")?.permission).toBe("analytics.revenue.view");
  });
});
