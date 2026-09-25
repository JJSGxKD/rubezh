import { describe, expect, it } from "vitest";
import { manualRate } from "../src/manual.js";
import { MemoryRateStore } from "../src/memory-store.js";
import { quoteInUsd, type Quote } from "../src/quote.js";
import { Decimal } from "../src/decimal.js";
import { convert, MissingRateError, payoutUsdPerUnit, rateOf } from "../src/rates.js";
import { refreshRates, takeSnapshot, type RateAlerts } from "../src/refresh.js";
import { SourceRateLimitedError, SourceUnavailableError, type RateSource } from "../src/sources.js";
import { rateStoreContract } from "./store-contract.js";

/**
 * Проход обновления курсов (docs/35-stage4-plan.md, WP9): источники в своём
 * бюджете, отказ одного не мешает другим, скачок одного не проходит,
 * молчание даёт «устарел», просроченный заданный курс — алерт, а снимок не
 * содержит того, по чему продавать нельзя.
 */

const T0 = new Date("2026-09-25T12:00:00Z");
const MINUTE = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

type Behaviour = (now: Date) => Quote[];

function source(id: string, behaviour: Behaviour, now: () => Date): RateSource & { calls: number } {
  const result = {
    id,
    currencies: [],
    tariff: { name: "test", perMinute: 60, perMonth: null, minIntervalMs: 5 * MINUTE },
    calls: 0,
    async fetch() {
      result.calls++;
      return behaviour(now());
    },
  };
  return result;
}

function alertsLog(): RateAlerts & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    rejected: (currency, decision) => void log.push(`rejected ${currency} ${decision.reason}`),
    stale: (currency, state, purpose) => void log.push(`stale ${currency} ${state}${purpose === undefined ? "" : ` ${purpose}`}`),
    sourceFailed: (id) => void log.push(`failed ${id}`),
  };
}

const gram = (id: string, usd: string): Behaviour => (now) => [quoteInUsd("GRAM", usd, id, now)];

describe("проход обновления", () => {
  it("принимает медиану трёх источников и соблюдает интервал источника", async () => {
    let now = T0;
    const store = new MemoryRateStore();
    const sources = [source("a", gram("a", "1.43"), () => now), source("b", gram("b", "1.42"), () => now), source("c", gram("c", "1.44"), () => now)];

    const first = await refreshRates({ sources, store, alerts: alertsLog(), now });
    expect(first.polled).toEqual(["a", "b", "c"]);
    expect((await store.currentRate("GRAM"))?.usdPerUnit.toString()).toBe("1.43");

    now = at(MINUTE);
    const soon = await refreshRates({ sources, store, alerts: alertsLog(), now });
    expect(soon.polled).toEqual([]);
    expect(sources.every((item) => item.calls === 1)).toBe(true);
  });

  it("скачок одного источника не проходит, а курс держится и стареет", async () => {
    let now = T0;
    const store = new MemoryRateStore();
    let price = "1.43";
    const sources = [source("a", (moment) => [quoteInUsd("GRAM", price, "a", moment)], () => now)];
    await refreshRates({ sources, store, alerts: alertsLog(), now });

    price = "0.70";
    now = at(5 * MINUTE);
    const alerts = alertsLog();
    const report = await refreshRates({ sources, store, alerts, now });

    expect(report.rejected).toEqual(["GRAM"]);
    expect(alerts.log).toContain("rejected GRAM jump_unconfirmed");
    expect((await store.currentRate("GRAM"))?.usdPerUnit.toString()).toBe("1.43");

    // полчаса одних отказов — курс устарел, и об этом сказано
    now = at(40 * MINUTE);
    const later = alertsLog();
    await refreshRates({ sources, store, alerts: later, now });
    expect(later.log).toContain("stale GRAM stale");
  });

  it("подтверждённый тем же значением курс снова свежий, но в историю — раз в час", async () => {
    let now = T0;
    const store = new MemoryRateStore();
    const sources = [source("a", gram("a", "1.43"), () => now)];
    for (let step = 0; step < 13; step++) {
      now = at(step * 5 * MINUTE);
      const alerts = alertsLog();
      await refreshRates({ sources, store, alerts, now });
      expect(alerts.log.filter((line) => line.startsWith("stale GRAM"))).toEqual([]);
    }
    // 0, 60 минут — две строки за час опросов раз в пять минут
    expect(store.historyOf("GRAM").map((entry) => entry.acceptedAt)).toEqual([T0, at(60 * MINUTE)]);
  });

  it("отказ источника не мешает другим, лимит — пауза без алерта", async () => {
    const now = T0;
    const store = new MemoryRateStore();
    const broken = source("broken", () => {
      throw new SourceUnavailableError("broken", "ответ 503");
    }, () => now);
    const limited = source("limited", () => {
      throw new SourceRateLimitedError("limited", 3_600_000);
    }, () => now);
    const alerts = alertsLog();
    const report = await refreshRates({ sources: [broken, limited, source("ok", gram("ok", "1.43"), () => now)], store, alerts, now });

    expect(report.polled).toEqual(["ok"]);
    expect(report.failed).toEqual(["broken", "limited"]);
    expect(alerts.log).toContain("failed broken");
    expect(alerts.log).not.toContain("failed limited");
    expect((await store.sourceState("limited"))?.nextPollAt).toEqual(at(3_600_000));
    expect((await store.sourceState("broken"))?.usage.used).toBe(1);
    expect((await store.currentRate("GRAM"))?.usdPerUnit.toString()).toBe("1.43");
  });

  it("нет курса и нет заданных курсов звёзд — алерты о каждом", async () => {
    const alerts = alertsLog();
    await refreshRates({ sources: [], store: new MemoryRateStore(), alerts, now: T0 });
    expect(alerts.log).toEqual(expect.arrayContaining(["stale RUB missing", "stale GRAM missing", "stale XTR missing price", "stale XTR missing payout"]));
    expect(alerts.log.some((line) => line.includes(" USD "))).toBe(false);
  });

  it("просроченный заданный курс — алерт, в снимок он не попадает", async () => {
    const store = new MemoryRateStore();
    await store.appendManual(manualRate({ currency: "XTR", purpose: "price", price: "0.013", setBy: "owner", setAt: at(-60 * 86_400_000), expiresAt: at(-31 * 86_400_000), note: "" }));
    await store.appendManual(manualRate({ currency: "XTR", purpose: "payout", price: "0.0105", setBy: "owner", setAt: T0, expiresAt: at(30 * 86_400_000), note: "" }));
    const alerts = alertsLog();
    await refreshRates({ sources: [], store, alerts, now: T0 });
    expect(alerts.log).toContain("stale XTR expired price");

    const snapshot = await takeSnapshot(store, T0);
    expect(() => convert(50, "XTR", "USD", snapshot)).toThrow(MissingRateError);
    expect(payoutUsdPerUnit(snapshot, "XTR").toString()).toBe("0.0105");
  });

  it("снимок: принятые курсы и заданные, 50 звёзд в Gram — по снимку", async () => {
    const now = T0;
    const store = new MemoryRateStore();
    await refreshRates({ sources: [source("a", gram("a", "1.3"), () => now)], store, alerts: alertsLog(), now });
    await store.appendManual(manualRate({ currency: "XTR", purpose: "price", price: "0.013", setBy: "owner", setAt: T0, expiresAt: at(30 * 86_400_000), note: "" }));

    const snapshot = await takeSnapshot(store, now);
    expect((await store.snapshot(snapshot.id))?.rates.size).toBe(2);
    expect(convert(50, "XTR", "GRAM", snapshot).toString()).toBe("0.5");
  });
});

describe("курс звезды в рублях", () => {
  it("снимок переводит его по принятому курсу рубля, без курса рубля звезды нет", async () => {
    const store = new MemoryRateStore();
    await store.appendManual(manualRate({ currency: "XTR", purpose: "price", price: "1.72", quote: "RUB", setBy: "owner", setAt: T0, expiresAt: at(90 * 86_400_000), note: "" }));
    const withoutRub = await takeSnapshot(store, T0);
    expect(withoutRub.rates.has("XTR")).toBe(false);

    await store.setCurrentRate(rateOf("RUB", new Decimal(1).div("84.6952"), ["cbr"], T0), T0);
    const snapshot = await takeSnapshot(store, T0);
    expect(snapshot.rates.get("XTR")?.usdPerUnit.toDecimalPlaces(5).toString()).toBe("0.02031");
    // 0,99 $ — 48,7 звезды: пересчёт по звезде в рублях
    expect(convert("0.99", "USD", "XTR", snapshot).toDecimalPlaces(1).toString()).toBe("48.7");
  });
});

describe("хранилище в памяти", () => {
  rateStoreContract(async () => ({ store: new MemoryRateStore(), source: (name) => name }));
});
