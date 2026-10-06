import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Decimal } from "../src/decimal.js";
import { createBinanceSource, createCoinGeckoSource, createTonApiSource, COINGECKO_TARIFFS } from "../src/sources/crypto.js";
import { createCbrSource, createEcbSource, createErApiSource } from "../src/sources/fiat.js";
import { retryAfterMs, type FetchLike } from "../src/sources/http.js";
import { SourceRateLimitedError, SourceUnavailableError } from "../src/sources.js";
import type { Quote } from "../src/quote.js";

/**
 * Адаптеры бесплатных источников (docs/35-stage4-plan.md, WP9, Р35) на
 * ответах, снятых с источников 25 сентября 2026. Проверяется не «разобрали»,
 * а то, где разбор ломается: кодировка ЦБ, номинал, база ЕЦБ в евро, «единиц
 * за доллар», метка вместо тикера, смена формата и отказ по лимиту.
 */

const fixture = (name: string): Uint8Array => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
const NOW = new Date("2026-09-25T12:00:00Z");
const signal = AbortSignal.timeout(5_000);

interface Call {
  url: string;
  headers: Record<string, string>;
}

function answering(body: Uint8Array | string, init: ResponseInit = {}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, request) => {
      calls.push({ url, headers: (request.headers ?? {}) as Record<string, string> });
      return new Response(typeof body === "string" ? body : Buffer.from(body), { status: 200, ...init });
    },
  };
}

const usd = (quotes: Quote[], code: string): string | undefined => quotes.find((quote) => quote.currency === code)?.usdPerUnit.toString();

describe("ЦБ РФ", () => {
  it("раскодирует windows-1251, делит на номинал и переводит рубль через доллар", async () => {
    const quotes = await createCbrSource(answering(fixture("cbr-daily.xml"))).fetch(signal);

    // 1 USD = 84.9057 ₽, 1 EUR = 96.8859 ₽
    expect(new Decimal(usd(quotes, "RUB") ?? "0").mul("84.9057").toDecimalPlaces(20).toString()).toBe("1");
    expect(new Decimal(usd(quotes, "EUR") ?? "0").toDecimalPlaces(6).toString()).toBe("1.1411");
    expect(quotes.map((quote) => quote.currency).sort()).toEqual(["EUR", "RUB"]);
    // курс действует с полуночи 25 сентября по Москве
    expect(quotes[0]?.observedAt).toEqual(new Date("2026-09-24T21:00:00Z"));
  });

  it("номинал: цена за сто единиц делится на сто", async () => {
    const xml = `<?xml version="1.0"?><ValCurs Date="25.09.2026"><Valute ID="R01235"><CharCode>USD</CharCode><Nominal>1</Nominal><Value>80,0000</Value></Valute><Valute ID="R01239"><CharCode>EUR</CharCode><Nominal>100</Nominal><Value>9 000,0000</Value></Valute></ValCurs>`;
    const quotes = await createCbrSource(answering(xml)).fetch(signal);
    expect(usd(quotes, "EUR")).toBe("1.125");
  });

  it("ответ без доллара или без даты — отказ источника, а не курс", async () => {
    const withoutUsd = `<ValCurs Date="25.09.2026"><Valute><CharCode>EUR</CharCode><Nominal>1</Nominal><Value>96,8859</Value></Valute></ValCurs>`;
    await expect(createCbrSource(answering(withoutUsd)).fetch(signal)).rejects.toThrow(/нет цены доллара/);
    await expect(createCbrSource(answering("<html>технические работы</html>")).fetch(signal)).rejects.toBeInstanceOf(SourceUnavailableError);
  });
});

describe("ЕЦБ и запасной форекс", () => {
  it("ЕЦБ: база в евро, курс доллара — сколько долларов за евро", async () => {
    const quotes = await createEcbSource(answering(fixture("ecb-daily.xml"))).fetch(signal);
    expect(usd(quotes, "EUR")).toBe("1.1367");
    expect(quotes.map((quote) => quote.currency)).toEqual(["EUR"]);
    expect(quotes[0]?.observedAt).toEqual(new Date("2026-09-24T00:00:00Z"));
  });

  it("ExchangeRate-API: «единиц за доллар» разворачивается, лишние валюты отброшены", async () => {
    const quotes = await createErApiSource(answering(fixture("erapi-latest.json"))).fetch(signal);
    expect(quotes.map((quote) => quote.currency).sort()).toEqual(["EUR", "RUB"]);
    expect(new Decimal(usd(quotes, "RUB") ?? "0").mul("84.485696").toDecimalPlaces(20).toString()).toBe("1");
    expect(quotes[0]?.observedAt).toEqual(new Date("2026-09-25T00:02:31Z"));
  });

  it("ответ с ошибкой вместо курсов — отказ", async () => {
    await expect(createErApiSource(answering(JSON.stringify({ result: "error", "error-type": "unsupported-code" }))).fetch(signal)).rejects.toThrow(/не того формата/);
  });
});

describe("крипта", () => {
  it("CoinGecko: Gram по метке the-open-network, USDT по tether, время — источника", async () => {
    const quotes = await createCoinGeckoSource({ ...answering(fixture("coingecko-simple-price.json")), now: () => NOW }).fetch(signal);
    expect(usd(quotes, "GRAM")).toBe("1.43");
    expect(usd(quotes, "USDT")).toBe("0.999829");
    expect(quotes.find((quote) => quote.currency === "GRAM")?.observedAt).toEqual(new Date(1_790_335_670_000));
  });

  it("CoinGecko: посторонний жетон с тикером GRAM в ответе не подменяет Gram", async () => {
    const body = JSON.stringify({ "gram-imposter": { usd: 0.004 }, "the-open-network": { usd: 1.43 } });
    const quotes = await createCoinGeckoSource({ ...answering(body), now: () => NOW }).fetch(signal);
    expect(quotes.filter((quote) => quote.currency === "GRAM").map((quote) => quote.usdPerUnit.toString())).toEqual(["1.43"]);
  });

  it("CoinGecko: ключ выбирает тариф, адрес и заголовок — без правки кода", async () => {
    const keyless = answering(fixture("coingecko-simple-price.json"));
    const demo = answering(fixture("coingecko-simple-price.json"));
    const pro = answering(fixture("coingecko-simple-price.json"));
    const sources = {
      keyless: createCoinGeckoSource(keyless),
      demo: createCoinGeckoSource({ ...demo, key: { plan: "demo", value: "CG-demo" } }),
      pro: createCoinGeckoSource({ ...pro, key: { plan: "pro", value: "CG-pro" } }),
    };
    await Promise.all(Object.values(sources).map((source) => source.fetch(signal)));

    expect(sources.keyless.tariff).toBe(COINGECKO_TARIFFS.keyless);
    expect(sources.demo.tariff).toBe(COINGECKO_TARIFFS.demo);
    expect(sources.pro.tariff).toBe(COINGECKO_TARIFFS.pro);
    expect(keyless.calls[0]?.url).toMatch(/^https:\/\/api\.coingecko\.com\//);
    expect(keyless.calls[0]?.headers).not.toHaveProperty("x-cg-demo-api-key");
    expect(demo.calls[0]?.headers).toMatchObject({ "x-cg-demo-api-key": "CG-demo" });
    expect(pro.calls[0]?.url).toMatch(/^https:\/\/pro-api\.coingecko\.com\//);
    expect(pro.calls[0]?.headers).toMatchObject({ "x-cg-pro-api-key": "CG-pro" });
  });

  it("TON API: ключ ответа прописными, котировка — на момент ответа", async () => {
    const quotes = await createTonApiSource({ ...answering(fixture("tonapi-rates.json")), now: () => NOW }).fetch(signal);
    expect(quotes).toHaveLength(1);
    expect(usd(quotes, "GRAM")).toBe("1.426857314");
    expect(quotes[0]?.observedAt).toEqual(NOW);
  });

  it("Binance: пара GRAMUSDT, цена строкой — без двоичной дроби", async () => {
    const quotes = await createBinanceSource({ ...answering(fixture("binance-ticker.json")), now: () => NOW }).fetch(signal);
    expect(usd(quotes, "GRAM")).toBe("1.427");
    await expect(createBinanceSource(answering(JSON.stringify({ symbol: "TONUSDT", price: "1.4" }))).fetch(signal)).rejects.toThrow(/чужую пару/);
  });
});

describe("сбои источника", () => {
  it("429 — лимит с Retry-After, а не поломка", async () => {
    const limited = createCoinGeckoSource(answering("{}", { status: 429, headers: { "retry-after": "120" } }));
    await expect(limited.fetch(signal)).rejects.toMatchObject({ name: "SourceRateLimitedError", retryAfterMs: 120_000 });
    await expect(limited.fetch(signal)).rejects.toBeInstanceOf(SourceRateLimitedError);
  });

  it("5xx, обрыв сети и огромный ответ — источник недоступен", async () => {
    await expect(createTonApiSource(answering("", { status: 503 })).fetch(signal)).rejects.toThrow(/ответ 503/);
    const broken: FetchLike = async () => Promise.reject(new TypeError("fetch failed"));
    await expect(createTonApiSource({ fetch: broken }).fetch(signal)).rejects.toThrow(/fetch failed/);
    await expect(createTonApiSource(answering("x".repeat(1_000_001))).fetch(signal)).rejects.toThrow(/больше предела/);
  });

  it("Retry-After — секунды или дата; непонятное — как отсутствие", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("Fri, 25 Sep 2026 12:01:00 GMT", Date.parse("2026-09-25T12:00:00Z"))).toBe(60_000);
    expect(retryAfterMs("скоро")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});
