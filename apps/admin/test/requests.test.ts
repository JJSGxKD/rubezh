import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  callOutcome,
  fetchInbound,
  fetchOutboundCalls,
  fetchOutboundSummary,
  formatLatency,
  formatShare,
  inboundSchema,
  outboundCallsSchema,
  outboundSummarySchema,
  seriesChart,
  serverErrorTone,
  viaLabel,
} from "../src/api/requests";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const AT = "2026-10-12T13:00:00.000Z";

describe("запросы к серверу в панели", () => {
  it("период и фильтры уходят в запросе; «только ошибки» — errors=1, пустая служба не отправляется", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { period: "week", from: AT, to: AT, services: [] } }), json(200, { data: { calls: [], next: null } }), json(200, { data: { calls: [], next: null } }));
    const api = new AdminApi(fetch);

    await fetchOutboundSummary(api, "week");
    await fetchOutboundCalls(api, { period: "day", service: "telegram.bot", errorsOnly: true, before: "51" });
    await fetchOutboundCalls(api, { period: "hour", service: "", errorsOnly: false });

    expect(calls[0]?.url).toBe("/api/v1/admin/requests/outbound/summary?period=week");
    expect(calls[1]?.url).toBe("/api/v1/admin/requests/outbound?period=day&service=telegram.bot&errors=1&before=51");
    expect(calls[2]?.url).toBe("/api/v1/admin/requests/outbound?period=hour");
  });

  it("входящие: адрес с периодом", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { period: "hour", step: "minute", from: AT, to: AT, series: [], routes: [] } }));
    const result = await fetchInbound(new AdminApi(fetch), "hour");
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/v1/admin/requests/inbound?period=hour");
  });

  it("разбор ответов: сводка, страница вызовов, входящие", () => {
    const summary = outboundSummarySchema.parse({
      period: "day",
      from: AT,
      to: AT,
      services: [{ service: "telegram.bot", count: 200, errors: 5, errorRate: 0.025, viaProxy: 40, median: { ms: 90, atLeast: false }, p95: { ms: 480, atLeast: false } }],
    });
    expect(summary.services[0]?.errorRate).toBe(0.025);

    const page = outboundCallsSchema.parse({
      calls: [{ id: "7", at: AT, service: "fx.cbr", method: "GET", host: "cbr.ru", path: "/daily", status: null, ok: false, durationMs: 5000, via: "direct", attempt: 2, error: "timeout" }],
      next: "7",
    });
    expect(page.calls[0]?.error).toBe("timeout");

    const inbound = inboundSchema.parse({
      period: "week",
      step: "hour",
      from: AT,
      to: AT,
      series: [{ at: AT, total: 10, errors: 1 }],
      routes: [{ method: "GET", route: "/api/v1/me", count: 10, c4xx: 1, c5xx: 1, median: null, p95: { ms: 5000, atLeast: true } }],
    });
    expect(inbound.routes[0]?.p95).toEqual({ ms: 5000, atLeast: true });
  });

  it("ответ не по схеме — не данные: время не числом отвергается", () => {
    expect(() => inboundSchema.parse({ period: "day", step: "hour", from: AT, to: AT, series: [], routes: [{ method: "GET", route: "/", count: 1, c4xx: 0, c5xx: 0, median: { ms: "быстро", atLeast: false }, p95: null }] })).toThrow();
  });
});

describe("доля 5xx → тон", () => {
  it("0,9% — обычный, 1% — опасность", () => {
    expect(serverErrorTone(1000, 9)).toBe("neutral");
    expect(serverErrorTone(1000, 10)).toBe("danger");
    expect(serverErrorTone(100, 1)).toBe("danger");
    expect(serverErrorTone(101, 1)).toBe("neutral");
  });

  it("нет ответов или нет 5xx — обычный", () => {
    expect(serverErrorTone(0, 0)).toBe("neutral");
    expect(serverErrorTone(500, 0)).toBe("neutral");
  });
});

describe("подписи", () => {
  it("доля: проценты с запятой, малая ненулевая не округляется до нуля", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.025)).toBe("2,5%");
    expect(formatShare(0.01)).toBe("1%");
    expect(formatShare(0.0004)).toBe("<0,1%");
    expect(formatShare(1)).toBe("100%");
  });

  it("время: миллисекунды, секунды; верхняя корзина — «≥ 5 с», нет данных — прочерк", () => {
    expect(formatLatency({ ms: 90, atLeast: false })).toBe("90 мс");
    expect(formatLatency({ ms: 1000, atLeast: false })).toBe("1 с");
    expect(formatLatency({ ms: 2500, atLeast: false })).toBe("2,5 с");
    expect(formatLatency({ ms: 5000, atLeast: false })).toBe("5 с");
    expect(formatLatency({ ms: 5000, atLeast: true })).toBe("≥ 5 с");
    expect(formatLatency(null)).toBe("—");
  });

  it("исход вызова: статус, причина сбоя словами, попытка и прокси", () => {
    expect(callOutcome({ status: 200, ok: true, error: null })).toBe("200");
    expect(callOutcome({ status: 503, ok: false, error: null })).toBe("503");
    expect(callOutcome({ status: null, ok: false, error: "timeout" })).toBe("не ответил вовремя");
    expect(callOutcome({ status: null, ok: false, error: "network" })).toBe("сеть недоступна");
    expect(callOutcome({ status: null, ok: false, error: "aborted" })).toBe("прерван");
    expect(callOutcome({ status: null, ok: false, error: "странное" })).toBe("странное");
    expect(callOutcome({ status: null, ok: false, error: null })).toBe("сбой");
    expect(viaLabel("direct")).toBe("напрямую");
    expect(viaLabel("proxy-eu-1")).toBe("proxy-eu-1");
  });
});

describe("график входящих", () => {
  const series = [
    { at: "2026-10-12T11:00:00.000Z", total: 100, errors: 0 },
    { at: "2026-10-12T12:00:00.000Z", total: 0, errors: 0 },
    { at: "2026-10-12T13:00:00.000Z", total: 50, errors: 25 },
  ];

  it("высоты — доля от максимума, 5xx отдельным рядом, тишина — нулевая высота", () => {
    const chart = seriesChart(series);
    expect(chart.max).toBe(100);
    expect(chart.bars.map((bar) => bar.total)).toEqual([1, 0, 0.5]);
    expect(chart.bars.map((bar) => bar.errors)).toEqual([0, 0, 0.25]);
  });

  it("пустой период: максимум 0, высоты нулевые, без деления на ноль", () => {
    const chart = seriesChart([{ at: AT, total: 0, errors: 0 }]);
    expect(chart.max).toBe(0);
    expect(chart.bars).toEqual([{ at: AT, total: 0, errors: 0 }]);
  });
});

describe("меню", () => {
  it("раздел «Запросы» — в «Эксплуатации» после «Диагностики», за правом requests.view", () => {
    const ids = SECTIONS.map((section) => section.id);
    expect(ids.indexOf("requests")).toBe(ids.indexOf("diagnostics") + 1);
    expect(SECTIONS.find((section) => section.id === "requests")).toMatchObject({ title: "Запросы", permission: "requests.view" });
  });
});
