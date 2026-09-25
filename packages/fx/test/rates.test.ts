import { describe, expect, it } from "vitest";
import { Decimal } from "../src/decimal.js";
import { aggregate, median } from "../src/rates/aggregate.js";
import { checkSpike, DEFAULT_SPIKE_RULES, relativeChange } from "../src/rates/checks.js";
import { acceptedFromFixed, activeFixedRate, findFixedRateProblems, fixedRateAudit, parseFixedRateValue, type FixedRate } from "../src/rates/fixed-rates.js";
import { DEFAULT_FRESHNESS, findStaleRates, isStale } from "../src/rates/freshness.js";
import type { AcceptedRate } from "../src/rates/rate.js";
import { convert, createSnapshot, crossRate, hasStaleQuotes, MissingRateError, revenueInUsd, snapshotCurrencies } from "../src/rates/snapshot.js";

// Модель курсов (docs/35-stage4-plan.md §3.12): одно соглашение, снимок,
// кросс-курсы через опорную валюту, свежесть, заданные курсы со сроком.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 25, 12);

function accepted(overrides: Partial<AcceptedRate> & Pick<AcceptedRate, "currency" | "usdPerUnit">): AcceptedRate {
  return { purpose: "price", sources: ["test"], acceptedAt: NOW, fixed: false, ...overrides };
}

const RATES: AcceptedRate[] = [
  accepted({ currency: "RUB", usdPerUnit: Decimal.ONE.div("92.5", 18), sources: ["cbr"] }),
  accepted({ currency: "EUR", usdPerUnit: Decimal.of("1.08"), sources: ["ecb"] }),
  accepted({ currency: "GRAM", usdPerUnit: Decimal.of("3.2"), sources: ["coingecko", "tonapi"] }),
  accepted({ currency: "USDT", usdPerUnit: Decimal.of("0.9998") }),
  accepted({ currency: "XTR", usdPerUnit: Decimal.of("0.02"), fixed: true, validUntil: NOW + 30 * 24 * HOUR, sources: ["fixed"] }),
  accepted({ currency: "XTR", purpose: "revenue", usdPerUnit: Decimal.of("0.013"), fixed: true, validUntil: NOW + 30 * 24 * HOUR, sources: ["fixed"] }),
];

describe("снимок и пересчёт", () => {
  const snapshot = createSnapshot({ id: "snap-1", at: NOW, accepted: RATES, freshness: DEFAULT_FRESHNESS });

  it("всегда содержит опорную валюту с курсом 1", () => {
    expect(snapshot.quotes.USD?.usdPerUnit.eq(1)).toBe(true);
    expect(snapshotCurrencies(snapshot).sort()).toEqual(["EUR", "GRAM", "RUB", "USD", "USDT", "XTR"]);
  });

  it("пересчитывает через доллар без потери точности", () => {
    expect(convert(Decimal.of("100"), "USD", "RUB", snapshot).round(2).toString()).toBe("9250");
    expect(convert(Decimal.of("9250"), "RUB", "USD", snapshot).round(6).toString()).toBe("100");
    expect(convert(Decimal.of("1"), "EUR", "RUB", snapshot).round(2).toString()).toBe("99.9");
    expect(convert(Decimal.of("10"), "GRAM", "EUR", snapshot).round(4).toString()).toBe("29.6296");
    expect(convert(Decimal.of("5"), "GRAM", "GRAM", snapshot).toString()).toBe("5");
    expect(crossRate("USD", "XTR", snapshot).toString()).toBe("50");
    expect(crossRate("EUR", "EUR", snapshot).toString()).toBe("1");
  });

  it("считает выручку по курсу выручки, а цену — по курсу цены", () => {
    expect(convert(Decimal.of("50"), "XTR", "USD", snapshot).toString()).toBe("1");
    expect(revenueInUsd(Decimal.of("50"), "XTR", snapshot).toString()).toBe("0.65");
    expect(revenueInUsd(Decimal.of("2"), "GRAM", snapshot).toString()).toBe("6.4");
  });

  it("называет валюту, которой нет в снимке", () => {
    const empty = createSnapshot({ id: "snap-empty", at: NOW, accepted: [], freshness: DEFAULT_FRESHNESS });
    expect(() => convert(Decimal.ONE, "USD", "RUB", empty)).toThrow(MissingRateError);
    expect(() => crossRate("GRAM", "USD", empty)).toThrow(/нет курса GRAM/);
  });

  it("помечает устаревшие курсы и курс выручки без пары не берёт", () => {
    const later = createSnapshot({ id: "snap-2", at: NOW + 3 * HOUR, accepted: RATES, freshness: DEFAULT_FRESHNESS });
    expect(later.quotes.GRAM?.stale).toBe(true);
    expect(later.quotes.RUB?.stale).toBe(false);
    expect(hasStaleQuotes(later, ["RUB", "GRAM"])).toBe(true);
    expect(hasStaleQuotes(later, ["RUB", "EUR"])).toBe(false);

    const expiredRevenue = createSnapshot({
      id: "snap-3",
      at: NOW,
      accepted: [RATES[4]!, { ...RATES[5]!, validUntil: NOW - 1 }],
      freshness: DEFAULT_FRESHNESS,
    });
    expect(expiredRevenue.quotes.XTR?.stale).toBe(true);

    const orphan = createSnapshot({ id: "snap-4", at: NOW, accepted: [RATES[5]!], freshness: DEFAULT_FRESHNESS });
    expect(orphan.quotes.XTR).toBeUndefined();
  });
});

describe("свежесть", () => {
  it("судит по виду валюты, а у заданного курса — по сроку годности", () => {
    const rub = accepted({ currency: "RUB", usdPerUnit: Decimal.of("0.01") });
    const gram = accepted({ currency: "GRAM", usdPerUnit: Decimal.of("3") });
    expect(isStale(rub, NOW + 47 * HOUR, DEFAULT_FRESHNESS)).toBe(false);
    expect(isStale(rub, NOW + 49 * HOUR, DEFAULT_FRESHNESS)).toBe(true);
    expect(isStale(gram, NOW + 2 * HOUR, DEFAULT_FRESHNESS)).toBe(true);

    const fixed = accepted({ currency: "XTR", usdPerUnit: Decimal.of("0.02"), fixed: true, validUntil: NOW + HOUR, acceptedAt: NOW - 400 * 24 * HOUR });
    expect(isStale(fixed, NOW + HOUR, DEFAULT_FRESHNESS)).toBe(false);
    expect(isStale(fixed, NOW + HOUR + 1, DEFAULT_FRESHNESS)).toBe(true);

    const stale = findStaleRates([rub, gram, fixed], NOW + 2 * HOUR, DEFAULT_FRESHNESS);
    expect(stale.map((entry) => [entry.rate.currency, entry.reason])).toEqual([
      ["GRAM", "source_silent"],
      ["XTR", "fixed_expired"],
    ]);
    expect(stale[0]?.overdueMs).toBe(HOUR);
  });
});

describe("проверка скачка", () => {
  const quote = (sourceId: string, value: string) => ({ sourceId, usdPerUnit: Decimal.of(value) });

  it("считает относительное изменение и первый курс принимает без вопросов", () => {
    expect(relativeChange(Decimal.of("115"), Decimal.of("100")).toString()).toBe("0.15");
    expect(relativeChange(Decimal.of("85"), Decimal.of("100")).toString()).toBe("0.15");
    expect(relativeChange(Decimal.of("1"), Decimal.ZERO).gt("1e8")).toBe(true);
    expect(checkSpike(null, Decimal.of("3"), [quote("a", "3")], DEFAULT_SPIKE_RULES).ok).toBe(true);
  });

  it("пропускает изменение в пределах порога и держит границу включительно", () => {
    expect(checkSpike(Decimal.of("100"), Decimal.of("115"), [], DEFAULT_SPIKE_RULES).ok).toBe(true);
    expect(checkSpike(Decimal.of("100"), Decimal.of("115.01"), [], DEFAULT_SPIKE_RULES).ok).toBe(false);
  });

  it("принимает скачок только с двумя независимыми подтверждениями", () => {
    const previous = Decimal.of("100");
    const candidate = Decimal.of("130");
    const alone = checkSpike(previous, candidate, [quote("a", "130")], DEFAULT_SPIKE_RULES);
    expect(alone).toMatchObject({ ok: false, reason: "jump_unconfirmed" });

    const sameSourceTwice = checkSpike(previous, candidate, [quote("a", "130"), quote("a", "131")], DEFAULT_SPIKE_RULES);
    expect(sameSourceTwice.ok).toBe(false);

    const farApart = checkSpike(previous, candidate, [quote("a", "130"), quote("b", "140")], DEFAULT_SPIKE_RULES);
    expect(farApart.ok).toBe(false);

    const confirmed = checkSpike(previous, candidate, [quote("a", "130"), quote("b", "132")], DEFAULT_SPIKE_RULES);
    expect(confirmed).toMatchObject({ ok: true, confirmedBy: ["a", "b"] });
  });
});

describe("свод котировок", () => {
  const quote = (sourceId: string, value: string) => ({ sourceId, usdPerUnit: Decimal.of(value) });

  it("берёт медиану: один съехавший источник её не двигает", () => {
    expect(median([Decimal.of("3.2"), Decimal.of("30"), Decimal.of("3.1")]).toString()).toBe("3.2");
    expect(median([Decimal.of("3"), Decimal.of("4")]).toString()).toBe("3.5");
    expect(median([Decimal.of("7")]).toString()).toBe("7");
    expect(() => median([])).toThrow(/пустого/);
    const result = aggregate([quote("a", "3.2"), quote("b", "30"), quote("c", "3.1")], "median", []);
    expect(result?.usdPerUnit.toString()).toBe("3.2");
    expect(result?.sources).toEqual(["a", "b", "c"]);
  });

  it("у фиата берёт приоритетный источник, а без него — любой", () => {
    const quotes = [quote("open-er-api", "0.0109"), quote("cbr", "0.0108")];
    expect(aggregate(quotes, "priority", ["cbr", "open-er-api"])).toEqual({ usdPerUnit: Decimal.of("0.0108"), sources: ["cbr"] });
    expect(aggregate(quotes, "priority", ["ecb"])?.sources).toEqual(["open-er-api"]);
    expect(aggregate([], "priority", ["cbr"])).toBeNull();
  });
});

describe("заданные курсы", () => {
  const stars = (overrides: Partial<FixedRate> = {}): FixedRate => ({
    currency: "XTR",
    purpose: "price",
    usdPerUnit: Decimal.of("0.02"),
    validFrom: NOW - HOUR,
    validUntil: NOW + 30 * 24 * HOUR,
    setBy: "admin-1",
    reason: "цена звезды в приложении",
    ...overrides,
  });

  it("проходят проверку и называют поле в ошибке", () => {
    expect(findFixedRateProblems([stars(), stars({ purpose: "revenue", usdPerUnit: Decimal.of("0.013") })])).toEqual([]);
    const problems = findFixedRateProblems([
      stars({ usdPerUnit: Decimal.ZERO, validUntil: NOW - 2 * HOUR, setBy: "", reason: "" }),
      stars({ validFrom: NOW - 2 * HOUR }),
    ]);
    expect(problems).toContain("заданный курс XTR (price): курс должен быть больше нуля");
    expect(problems).toContain("заданный курс XTR (price): срок годности кончается раньше, чем начинается");
    expect(problems).toContain("заданный курс XTR (price): не указано, кто задал");
    expect(problems).toContain("заданный курс XTR (price): не указана причина");
    expect(findFixedRateProblems([stars(), stars({ validFrom: NOW })])).toContain("заданный курс XTR (price): два курса действуют одновременно");
  });

  it("действует самый поздний из начавшихся, просроченный остаётся до замены", () => {
    const old = stars({ validFrom: NOW - 10 * HOUR, validUntil: NOW - 5 * HOUR, usdPerUnit: Decimal.of("0.019") });
    const future = stars({ validFrom: NOW + HOUR, usdPerUnit: Decimal.of("0.021") });
    expect(activeFixedRate([old, future], "XTR", "price", NOW)?.usdPerUnit.toString()).toBe("0.019");
    expect(activeFixedRate([old, future], "XTR", "price", NOW + HOUR)?.usdPerUnit.toString()).toBe("0.021");
    expect(activeFixedRate([old], "XTR", "revenue", NOW)).toBeNull();

    const accepted = acceptedFromFixed([old, stars({ purpose: "revenue", usdPerUnit: Decimal.of("0.013") })], NOW);
    expect(accepted).toHaveLength(2);
    const price = accepted.find((rate) => rate.purpose === "price")!;
    expect(price).toMatchObject({ fixed: true, sources: ["fixed"], validUntil: NOW - 5 * HOUR });
    expect(isStale(price, NOW, DEFAULT_FRESHNESS)).toBe(true);
  });

  it("пишет аудит с прежним значением и читает курс из формы строкой", () => {
    const audit = fixedRateAudit(stars({ usdPerUnit: Decimal.of("0.019") }), stars({ reason: "подняли цену" }), NOW);
    expect(audit).toMatchObject({ currency: "XTR", purpose: "price", by: "admin-1", at: NOW, reason: "подняли цену" });
    expect(audit.previous?.toString()).toBe("0.019");
    expect(audit.next.toString()).toBe("0.02");
    expect(fixedRateAudit(null, stars(), NOW).previous).toBeNull();
    expect(parseFixedRateValue("0.013").toString()).toBe("0.013");
    expect(() => parseFixedRateValue("0")).toThrow(/больше нуля/);
    expect(() => parseFixedRateValue("0,013")).toThrow();
  });
});

describe("кодек снимка", () => {
  it("возвращает снимок из JSON без потери знаков и отвергает чужой JSON", async () => {
    const { cloneSnapshot, parseSnapshot, serializeSnapshot } = await import("../src/rates/snapshot-codec.js");
    const snapshot = createSnapshot({ id: "snap-codec", at: NOW, accepted: RATES, freshness: DEFAULT_FRESHNESS });
    const text = serializeSnapshot(snapshot);
    expect(text).toContain('"usdPerUnit":"0.010810810810810811"');
    const back = parseSnapshot(text);
    expect(back.quotes.RUB?.usdPerUnit.eq(snapshot.quotes.RUB!.usdPerUnit)).toBe(true);
    expect(back.quotes.XTR?.revenueUsdPerUnit.toString()).toBe("0.013");
    expect(cloneSnapshot(snapshot)).toEqual(back);
    expect(() => parseSnapshot('{"id":"x","at":1,"reference":"EUR","quotes":{}}')).toThrow();
    expect(() => parseSnapshot('{"id":"x","at":1,"reference":"USD","quotes":{"RUB":{"usdPerUnit":"1,5","revenueUsdPerUnit":"1","stale":false,"acceptedAt":1,"sources":[]}}}')).toThrow();
    expect(() => parseSnapshot('{"id":"x","at":1,"reference":"USD","quotes":{"BTC":{"usdPerUnit":"1","revenueUsdPerUnit":"1","stale":false,"acceptedAt":1,"sources":[]}}}')).toThrow();
  });
});
