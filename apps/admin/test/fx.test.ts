import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  budgetTone,
  correctSourceUsed,
  MANUAL_CURRENCIES,
  fetchFxOverview,
  isMarketCurrency,
  limitCaption,
  limitProblem,
  manualRateProblem,
  parseCount,
  refreshSource,
  refreshSummary,
  resetSourceLimit,
  setManualRate,
  setSourceLimit,
  sharePercent,
  usageText,
  usedProblem,
  type ManualRateInput,
  type RefreshResult,
} from "../src/api/fx";
import { formatNumber } from "../src/format";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const AT = "2026-09-25T10:00:00.000Z";

const MANUAL: ManualRateInput = { currency: "XTR", purpose: "price", price: "0.013", quote: "USD", expiresInDays: 30, note: "курс Fragment" };

const SOURCE = {
  source: "coingecko",
  tariff: "demo",
  month: "2026-09",
  used: 6_120,
  pausedUntil: null,
  nextPollAt: AT,
  limit: { perMonth: 10_000, from: "tariff" as const },
  usedShare: 0.612,
};

describe("курсы", () => {
  it("обзор разбирается, числа курсов остаются строками", async () => {
    const overview = {
      enabled: true,
      rates: [{ currency: "RUB", usdPerUnit: "0.0123456789", unitsPerUsd: "81.00000001", sources: ["cbr"], observedAt: AT, freshness: "fresh" }],
      missing: ["GRAM"],
      manual: [],
      sources: [{ source: "cbr", tariff: "free", month: "2026-09", used: 12, pausedUntil: null, nextPollAt: AT, limit: { perMonth: null, from: "tariff" }, usedShare: null }],
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

describe("лимиты источников", () => {
  it("обзор отдаёт лимит с происхождением и долю; «без лимита» — null", async () => {
    const overview = {
      enabled: true,
      rates: [],
      missing: [],
      manual: [],
      sources: [SOURCE, { ...SOURCE, source: "cbr", tariff: "official", used: 3, limit: { perMonth: null, from: "panel" as const }, usedShare: null }],
    };
    const result = await fetchFxOverview(new AdminApi(fakeFetch(json(200, { data: overview })).fetch));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sources[0]?.limit).toEqual({ perMonth: 10_000, from: "tariff" });
    expect(result.data.sources[0]?.usedShare).toBeCloseTo(0.612, 6);
    expect(result.data.sources[1]?.limit).toEqual({ perMonth: null, from: "panel" });
    expect(result.data.sources[1]?.usedShare).toBeNull();
  });

  it("ответ сервера без лимита (старее панели) не разбирается — честное «не разобрался»", async () => {
    const old: Partial<typeof SOURCE> = { ...SOURCE };
    delete old.limit;
    delete old.usedShare;
    const overview = { enabled: true, rates: [], missing: [], manual: [], sources: [old] };
    const result = await fetchFxOverview(new AdminApi(fakeFetch(json(200, { data: overview })).fetch));
    expect(result.ok).toBe(false);
  });

  it("тон по доле: 0,79 — обычный, 0,8 — предупреждение, 1 — опасность", () => {
    expect(budgetTone(null)).toBe("neutral");
    expect(budgetTone(0)).toBe("neutral");
    expect(budgetTone(0.79)).toBe("neutral");
    expect(budgetTone(0.8)).toBe("warning");
    expect(budgetTone(0.999)).toBe("warning");
    expect(budgetTone(1)).toBe("danger");
    expect(budgetTone(1.3)).toBe("danger");
  });

  it("доля в процентах — целая вниз и без ошибки двоичной дроби: 0,29 — это 29%, а не 28", () => {
    expect(sharePercent(0.29)).toBe(29);
    expect(sharePercent(0.612)).toBe(61);
    expect(sharePercent(0.8)).toBe(80);
    expect(sharePercent(0.999)).toBe(99);
    expect(sharePercent(1)).toBe(100);
    expect(sharePercent(1.2)).toBe(120);
    expect(sharePercent(0)).toBe(0);
  });

  it("подписи: «6 120 из 10 000», «без лимита», откуда лимит", () => {
    expect(usageText(SOURCE)).toBe(`${formatNumber(6_120)} из ${formatNumber(10_000)}`);
    expect(usageText({ ...SOURCE, limit: { perMonth: null, from: "tariff" } })).toBe(`${formatNumber(6_120)}, без лимита`);
    expect(limitCaption(SOURCE)).toBe("по тарифу «demo»");
    expect(limitCaption({ ...SOURCE, limit: { perMonth: 20_000, from: "panel" } })).toBe("задан в панели");
  });

  it("число из поля: пробелы разрядов не мешают, мусор — NaN", () => {
    expect(parseCount("10000")).toBe(10_000);
    expect(parseCount(" 10 000 ")).toBe(10_000);
    expect(parseCount(`10${String.fromCharCode(0xa0)}000`)).toBe(10_000);
    expect(parseCount("")).toBeNaN();
    expect(parseCount("1e5")).toBeNaN();
    expect(parseCount("-5")).toBeNaN();
    expect(parseCount("1.5")).toBeNaN();
  });

  it("форма лимита — те же границы, что у сервера", () => {
    expect(limitProblem({ perMonth: 10_000, note: "поставщик поднял тариф" })).toBeNull();
    expect(limitProblem({ perMonth: null, note: "безлимитный план" })).toBeNull();
    expect(limitProblem({ perMonth: 1, note: "abc" })).toBeNull();
    expect(limitProblem({ perMonth: 100_000_000, note: "abc" })).toBeNull();
    expect(limitProblem({ perMonth: 0, note: "причина" })).not.toBeNull();
    expect(limitProblem({ perMonth: 100_000_001, note: "причина" })).not.toBeNull();
    expect(limitProblem({ perMonth: 1.5, note: "причина" })).not.toBeNull();
    expect(limitProblem({ perMonth: Number.NaN, note: "причина" })).not.toBeNull();
    expect(limitProblem({ perMonth: 100, note: "  ab " })).not.toBeNull();
    expect(limitProblem({ perMonth: 100, note: "я".repeat(201) })).not.toBeNull();
  });

  it("форма счётчика — от 0 до 100 000 000, причина обязательна", () => {
    expect(usedProblem({ used: 0, note: "сверка" })).toBeNull();
    expect(usedProblem({ used: 100_000_000, note: "сверка" })).toBeNull();
    expect(usedProblem({ used: -1, note: "сверка" })).not.toBeNull();
    expect(usedProblem({ used: 100_000_001, note: "сверка" })).not.toBeNull();
    expect(usedProblem({ used: 0.5, note: "сверка" })).not.toBeNull();
    expect(usedProblem({ used: Number.NaN, note: "сверка" })).not.toBeNull();
    expect(usedProblem({ used: 5, note: " " })).not.toBeNull();
  });

  it("лимит уходит PUT с причиной, источник — в адресе, «без лимита» — null", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { ...SOURCE, limit: { perMonth: 20_000, from: "panel" }, usedShare: 0.306 } }), json(200, { data: { ...SOURCE, limit: { perMonth: null, from: "panel" }, usedShare: null } }));
    const api = new AdminApi(fetch);

    const raised = await setSourceLimit(api, "coingecko", { perMonth: 20_000, note: " поставщик поднял тариф " });
    expect(raised.ok && raised.data.limit).toEqual({ perMonth: 20_000, from: "panel" });
    expect(calls[0]?.url).toBe("/api/v1/admin/fx/sources/coingecko/limit");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ perMonth: 20_000, note: "поставщик поднял тариф" });

    await setSourceLimit(api, "coingecko", { perMonth: null, note: "безлимитный план" });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ perMonth: null, note: "безлимитный план" });
  });

  it("сброс к тарифу — DELETE без тела, имя источника экранируется", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: SOURCE }));
    const result = await resetSourceLimit(new AdminApi(fetch), "a/b");
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/v1/admin/fx/sources/a%2Fb/limit");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("счётчик уходит PUT с причиной", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { ...SOURCE, used: 5_000, usedShare: 0.5 } }));
    const result = await correctSourceUsed(new AdminApi(fetch), "coingecko", { used: 5_000, note: " сверились с кабинетом " });
    expect(result.ok && result.data.used).toBe(5_000);
    expect(calls[0]?.url).toBe("/api/v1/admin/fx/sources/coingecko/used");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ used: 5_000, note: "сверились с кабинетом" });
  });
});

describe("меню", () => {
  it("раздел — за правом его маршрутов на сервере", () => {
    expect(SECTIONS.find((section) => section.id === "fx")?.permission).toBe("analytics.revenue.view");
  });
});

describe("«Обновить сейчас» и запасной ручной курс (T-0064)", () => {
  const RESULT: RefreshResult = {
    source: "coingecko",
    ok: true,
    error: null,
    quotes: [
      { currency: "GRAM", usdPerUnit: "5.41", status: "accepted" },
      { currency: "USDT", usdPerUnit: "1", status: "accepted" },
    ],
    snapshotId: "s1",
  };

  it("запрос идёт на адрес источника, ответ разбирается схемой", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: RESULT }));
    const result = await refreshSource(new AdminApi(fetch), "coingecko");

    expect(result.ok && result.data.quotes).toHaveLength(2);
    expect([calls[0]?.url, calls[0]?.init.method]).toEqual(["/api/v1/admin/fx/sources/coingecko/refresh", "POST"]);
  });

  it("отказ сервера (лимит, пауза, занято) приходит текстом", async () => {
    const { fetch } = fakeFetch(json(429, { error: { code: "fx_refresh_too_soon", message: "Источник спрашивали только что — повторите через 5 с" } }));
    const result = await refreshSource(new AdminApi(fetch), "coingecko");
    expect(!result.ok && result.error).toMatchObject({ status: 429, message: "Источник спрашивали только что — повторите через 5 с" });
  });

  it("итог словами: что ответил источник, принят ли каждый курс, или причина сбоя", () => {
    expect(refreshSummary(RESULT)).toBe("CoinGecko ответил: Gram 5,41 $ — принят, USDT 1,00 $ — принят");
    expect(refreshSummary({ ...RESULT, quotes: [{ currency: "GRAM", usdPerUnit: "5.41", status: "rejected" }] })).toBe("CoinGecko ответил: Gram 5,41 $ — отклонён");
    expect(refreshSummary({ ...RESULT, quotes: [{ currency: "RUB", usdPerUnit: "0.0111", status: "waiting" }] })).toBe("CoinGecko ответил: рубль 0,0111 $ — ждёт других источников");
    expect(refreshSummary({ ...RESULT, ok: false, error: "HTTP 502", quotes: [] })).toBe("CoinGecko не ответил: HTTP 502");
    expect(refreshSummary({ ...RESULT, source: "cbr", quotes: [] })).toBe("ЦБ РФ ответил, но курсов не прислал");
  });

  it("ручной курс — любой валюте, кроме доллара; рыночная отличается от валюты площадки", () => {
    expect(MANUAL_CURRENCIES.map(([code]) => code)).toEqual(["XTR", "RUB", "EUR", "GRAM", "USDT"]);
    expect(isMarketCurrency("RUB")).toBe(true);
    expect(isMarketCurrency("GRAM")).toBe(true);
    expect(isMarketCurrency("XTR")).toBe(false);
  });

  it("форма: у рыночной валюты — только доллар, цена и до 7 дней; у звёзд всё как было, до 90", () => {
    const rub: ManualRateInput = { currency: "RUB", purpose: "price", price: "0.011", quote: "USD", expiresInDays: 7, note: "источники легли" };
    expect(manualRateProblem(rub)).toBeNull();
    expect(manualRateProblem({ ...rub, expiresInDays: 8 })).toMatch(/7/);
    expect(manualRateProblem({ ...rub, quote: "EUR" })).toMatch(/в долларах/);
    expect(manualRateProblem({ ...rub, purpose: "payout" })).toMatch(/только для цен/);
    expect(manualRateProblem({ ...MANUAL, expiresInDays: 90 })).toBeNull();
    expect(manualRateProblem({ ...MANUAL, expiresInDays: 91 })).not.toBeNull();
  });

  it("метка «запасной»: сервер говорит, что курс сейчас в работе; старый сервер без поля — не запасной", async () => {
    const base = { currency: "RUB", purpose: "price", price: "0.011", quote: "USD", usdPerUnit: "0.011", sources: ["manual:a1"], observedAt: AT, freshness: "fresh", setBy: "a1", expiresAt: AT, note: "запас" };
    const overview = { enabled: true, rates: [], missing: ["RUB"], sources: [], manual: [{ ...base, fallback: true }, { ...base, currency: "XTR" }] };
    const result = await fetchFxOverview(new AdminApi(fakeFetch(json(200, { data: overview })).fetch));

    expect(result.ok && result.data.manual.map((rate) => rate.fallback)).toEqual([true, false]);
  });
});
