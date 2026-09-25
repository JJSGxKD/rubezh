import { describe, expect, it } from "vitest";
import { Decimal } from "../src/decimal.js";
import { CollectingAlerts } from "../src/ports/alerts.js";
import { FixedClock } from "../src/ports/clock.js";
import { StubHttpClient } from "../src/ports/http.js";
import { MemoryLock, noLock } from "../src/ports/lock.js";
import { MemoryRateStore } from "../src/ports/memory-store.js";
import { collectRates, DEFAULT_COLLECT_RULES, type CollectorDeps, type ConfiguredSource } from "../src/rates/collector.js";
import type { AcceptedRate } from "../src/rates/rate.js";
import { resolveRates, type SourcedQuote } from "../src/rates/resolve.js";
import { materializeSnapshot } from "../src/rates/snapshot-builder.js";
import { binanceSource, cbrSource, coingeckoSource, ecbSource, openErApiSource, tonapiSource } from "../src/rates/sources/index.js";
import { BINANCE_JSON, CBR_XML, COINGECKO_JSON, ECB_XML, OPEN_ER_API_JSON, TONAPI_JSON } from "./fixtures/source-responses.js";

// Цикл сбора (docs/35-stage4-plan.md §3.12, «Надёжность»): под локом,
// медиана у крипты, приоритет у фиата, котировки в USDT — через курс USDT,
// скачок без подтверждения не проходит, молчание источника — алерт.

const NOW = Date.UTC(2026, 8, 25, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function http(overrides: Partial<Record<string, { status: number; body: string }>> = {}): StubHttpClient {
  const client = new StubHttpClient();
  client.answer(cbrSource.free.baseUrl, overrides.cbr ?? { status: 200, body: CBR_XML });
  client.answer(ecbSource.free.baseUrl, overrides.ecb ?? { status: 200, body: ECB_XML });
  client.answer(openErApiSource.free.baseUrl, overrides.openErApi ?? { status: 200, body: OPEN_ER_API_JSON });
  client.answer(coingeckoSource.free.baseUrl, overrides.coingecko ?? { status: 200, body: COINGECKO_JSON });
  client.answer(tonapiSource.free.baseUrl, overrides.tonapi ?? { status: 200, body: TONAPI_JSON });
  client.answer(binanceSource.free.baseUrl, overrides.binance ?? { status: 200, body: BINANCE_JSON });
  return client;
}

function deps(overrides: Partial<CollectorDeps> = {}): CollectorDeps & { clock: FixedClock; store: MemoryRateStore; alerts: CollectingAlerts } {
  const clock = new FixedClock(NOW);
  const sources: ConfiguredSource[] = [cbrSource, ecbSource, openErApiSource, coingeckoSource, tonapiSource, binanceSource].map((source) => ({ source }));
  return { sources, http: http(), store: new MemoryRateStore(), clock, lock: noLock, alerts: new CollectingAlerts(), rules: DEFAULT_COLLECT_RULES, ...overrides } as CollectorDeps & {
    clock: FixedClock;
    store: MemoryRateStore;
    alerts: CollectingAlerts;
  };
}

describe("первый цикл", () => {
  it("опрашивает все источники и принимает курсы: фиат по приоритету, крипту медианой, USDT-котировки через USDT", async () => {
    const d = deps();
    const report = await collectRates(d);

    expect(report.locked).toBe(true);
    expect(report.sources.map((entry) => [entry.sourceId, entry.status])).toEqual([
      ["cbr", "ok"],
      ["ecb", "ok"],
      ["open-er-api", "ok"],
      ["coingecko", "ok"],
      ["tonapi", "ok"],
      ["binance", "ok"],
    ]);
    const accepted = Object.fromEntries(report.accepted.map((rate) => [rate.currency, rate]));
    expect(accepted.RUB?.sources).toEqual(["cbr"]);
    expect(accepted.EUR?.sources).toEqual(["cbr"]);
    expect(accepted.EUR?.usdPerUnit.toString()).toBe("1.08");
    // USDT: медиана двух долларовых котировок (0.9998 и 0.9997) — 0.99975.
    expect(accepted.USDT?.usdPerUnit.toString()).toBe("0.99975");
    expect([...accepted.USDT!.sources].sort()).toEqual(["coingecko", "tonapi"]);
    // GRAM: coingecko 3.21, tonapi 3.2, binance 3.195 × 0.99975 = 3.194201...; медиана — 3.2.
    expect(accepted.GRAM?.usdPerUnit.toString()).toBe("3.2");
    expect([...accepted.GRAM!.sources].sort()).toEqual(["binance", "coingecko", "tonapi"]);
    expect(report.rejected).toEqual([]);
    expect(report.unresolved).toBe(0);

    const history = await d.store.observations("GRAM", 0);
    expect(history.map((entry) => entry.sourceId).sort()).toEqual(["binance", "coingecko", "tonapi"]);
    expect(history.find((entry) => entry.sourceId === "binance")?.usdPerUnit.toString()).toBe("3.19420125");
    expect(await d.store.countRequests("cbr", 0, NOW + 1)).toBe(1);
  });

  it("не запрашивает, кому не пора, и не трогает состояние пропущенных", async () => {
    const d = deps();
    await collectRates(d);
    d.clock.advance(2 * MINUTE);
    const second = await collectRates(d);
    const statuses = Object.fromEntries(second.sources.map((entry) => [entry.sourceId, entry.status]));
    // Суточным источникам не пора; крипте пора: в конце месяца остаток бюджета CoinGecko растянут на несколько дней, и интервал упирается в минутный пол.
    expect(statuses).toMatchObject({ cbr: "not_due", ecb: "not_due", "open-er-api": "not_due", tonapi: "ok", binance: "ok", coingecko: "ok" });
    expect(await d.store.countRequests("cbr", 0, NOW + HOUR)).toBe(1);
    expect((await d.store.sourceState("cbr"))?.lastPolledAt).toBe(NOW);
  });
});

describe("отказы источников", () => {
  it("429 ставит источник на паузу, остальные продолжают, обычная ошибка — не пауза", async () => {
    const d = deps({ http: http({ coingecko: { status: 429, body: "" }, cbr: { status: 500, body: "" } }) });
    const report = await collectRates(d);
    const statuses = Object.fromEntries(report.sources.map((entry) => [entry.sourceId, entry]));
    expect(statuses.coingecko).toMatchObject({ status: "rate_limited", quotes: 0 });
    expect(statuses.cbr).toMatchObject({ status: "error", quotes: 0 });
    expect(statuses.tonapi).toMatchObject({ status: "ok" });
    expect(report.accepted.find((rate) => rate.currency === "RUB")?.sources).toEqual(["open-er-api"]);
    expect(report.accepted.find((rate) => rate.currency === "EUR")?.sources).toEqual(["ecb"]);
    expect((await d.store.sourceState("coingecko"))?.pausedUntil).toBe(NOW + DEFAULT_COLLECT_RULES.planner.rateLimitPauseBaseMs);
    expect((await d.store.sourceState("cbr"))?.pausedUntil).toBeNull();
    expect(await d.store.countRequests("coingecko", 0, NOW + 1)).toBe(1);

    d.clock.advance(MINUTE);
    const next = await collectRates(d);
    expect(next.sources.find((entry) => entry.sourceId === "coingecko")?.status).toBe("paused");
  });

  it("сеть упала целиком — принятых нет, прежние курсы стоят, а через час крипта помечена устаревшей", async () => {
    const d = deps();
    await collectRates(d);
    const broken = new StubHttpClient();
    for (const source of [cbrSource, ecbSource, openErApiSource, coingeckoSource, tonapiSource, binanceSource]) broken.answer(source.free.baseUrl, new Error("обрыв"));
    d.http = broken;

    d.clock.advance(HOUR + MINUTE);
    const report = await collectRates(d);
    expect(report.accepted).toEqual([]);
    expect(report.sources.every((entry) => entry.status === "error" || entry.status === "not_due")).toBe(true);
    expect(report.stale.map((alert) => [alert.currency, alert.reason]).sort()).toEqual([
      ["GRAM", "source_silent"],
      ["USDT", "source_silent"],
    ]);
    expect(d.alerts.ofKind("rate_stale")).toHaveLength(2);
    expect((await d.store.latestAccepted()).find((rate) => rate.currency === "GRAM")?.usdPerUnit.toString()).toBe("3.2");

    const snapshot = await materializeSnapshot({ store: d.store, id: "snap-stale", now: d.clock.now(), freshness: DEFAULT_COLLECT_RULES.freshness });
    expect(snapshot.quotes.GRAM).toMatchObject({ stale: true });
    expect(snapshot.quotes.RUB).toMatchObject({ stale: false });
    expect((await d.store.getSnapshot("snap-stale"))?.id).toBe("snap-stale");
  });

  it("под чужим локом ничего не делает и говорит об этом", async () => {
    const clock = new FixedClock(NOW);
    const lock = new MemoryLock(() => clock.now());
    const d = deps({ clock, lock });
    const inner = await lock.withLock("fx:collect", HOUR, async () => collectRates(d));
    expect(inner).toEqual({ acquired: true, result: { at: NOW, locked: false, sources: [], accepted: [], rejected: [], stale: [], unresolved: 0 } });
    expect(await d.store.latestAccepted()).toEqual([]);
  });
});

describe("скачок", () => {
  it("один источник со скачком не переписывает курс, двое согласных — переписывают", async () => {
    const d = deps();
    await collectRates(d);

    // Через сутки ЦБ отдал рубль на 30 % дороже, а запасной источник — прежний: скачок не подтверждён.
    d.clock.advance(25 * HOUR);
    d.http = http({ cbr: { status: 200, body: CBR_XML.replace("92,5000", "71,1500") } });
    const rejected = await collectRates(d);
    expect(rejected.accepted.find((rate) => rate.currency === "RUB")).toBeUndefined();
    // Евро у ЦБ считается через доллар, поэтому «прыгает» вместе с рублём, а ЕЦБ его не подтверждает — тоже отклонён.
    expect(rejected.rejected.map((alert) => alert.currency).sort()).toEqual(["EUR", "RUB"]);
    // Согласившийся с кандидатом только он сам — одного источника для скачка мало.
    expect(rejected.rejected.find((alert) => alert.currency === "RUB")).toMatchObject({ kind: "rate_rejected", sources: ["cbr"], confirmedBy: ["cbr"] });
    expect(d.alerts.ofKind("rate_rejected")).toHaveLength(2);
    expect((await d.store.latestAccepted()).find((rate) => rate.currency === "RUB")?.usdPerUnit.toString()).toBe("0.010810810810810811");

    // Ещё через сутки оба источника согласны — курс принимается, хотя скачок тот же.
    d.clock.advance(25 * HOUR);
    d.http = http({
      cbr: { status: 200, body: CBR_XML.replace("92,5000", "71,1500") },
      openErApi: { status: 200, body: OPEN_ER_API_JSON.replace("RUB: 92.5", "RUB: 71.4").replace('"RUB":92.5', '"RUB":71.4') },
    });
    const confirmed = await collectRates(d);
    const rub = confirmed.accepted.find((rate) => rate.currency === "RUB");
    expect(rub?.sources).toEqual(["cbr"]);
    expect(rub?.usdPerUnit.round(6).toString()).toBe("0.014055");
    expect(confirmed.rejected.map((alert) => alert.currency)).toEqual(["EUR"]);
  });
});

describe("свод котировок без сети", () => {
  const quote = (sourceId: string, currency: SourcedQuote["currency"], price: string, quotedIn: SourcedQuote["quotedIn"] = "USD"): SourcedQuote => ({
    sourceId,
    currency,
    sourceCurrencyId: `${sourceId}:${currency}`,
    price: Decimal.of(price),
    quotedIn,
    observedAt: NOW,
  });

  it("котировку в USDT без курса USDT откладывает, с прошлым курсом — переводит", () => {
    const without = resolveRates({ quotes: [quote("binance", "GRAM", "3.2", "USDT")], previous: new Map(), spike: DEFAULT_COLLECT_RULES.spike, fiatPriority: [], now: NOW });
    expect(without.accepted).toEqual([]);
    expect(without.unresolved).toHaveLength(1);

    const previous = new Map<AcceptedRate["currency"], AcceptedRate>([["USDT", { currency: "USDT", purpose: "price", usdPerUnit: Decimal.of("0.5"), sources: [], acceptedAt: NOW - HOUR, fixed: false }]]);
    const withPrevious = resolveRates({ quotes: [quote("binance", "GRAM", "3.2", "USDT")], previous, spike: DEFAULT_COLLECT_RULES.spike, fiatPriority: [], now: NOW });
    expect(withPrevious.accepted[0]?.usdPerUnit.toString()).toBe("1.6");
    expect(withPrevious.observations[0]?.usdPerUnit.toString()).toBe("1.6");
  });
});
