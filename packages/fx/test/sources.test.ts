import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Decimal } from "../src/decimal.js";
import {
  COINGECKO_TARIFFS,
  COINMARKETCAP_CURRENCIES,
  COINMARKETCAP_TARIFF,
  TONAPI_TARIFFS,
  createBinanceSource,
  createCoinGeckoSource,
  createCoinMarketCapSource,
  createTonApiSource,
  parseCoinMarketCap,
} from "../src/sources/crypto.js";
import { ERAPI_TARIFFS, createCbrSource, createEcbSource, createErApiSource } from "../src/sources/fiat.js";
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

describe("CoinMarketCap", () => {
  const KEY = "00000000-aaaa-4bbb-8ccc-123456789abc";
  const source = (body: Uint8Array | string = fixture("coinmarketcap-quotes.json"), init: ResponseInit = {}) => {
    const served = answering(body, init);
    return { ...served, source: createCoinMarketCapSource({ fetch: served.fetch, key: KEY, now: () => NOW }) };
  };

  it("метки — числовые id, а не тикеры: Gram — 11419, USDT — 825", () => {
    expect(COINMARKETCAP_CURRENCIES).toEqual([
      { currency: "GRAM", sourceId: "11419" },
      { currency: "USDT", sourceId: "825" },
    ]);
  });

  it("Gram и USDT в долларах, время — last_updated каждой котировки", async () => {
    const quotes = await source().source.fetch(signal);
    expect(usd(quotes, "GRAM")).toBe("1.4301");
    expect(usd(quotes, "USDT")).toBe("0.99975");
    expect(quotes.find((quote) => quote.currency === "GRAM")?.observedAt).toEqual(new Date("2026-09-25T11:58:30.000Z"));
    expect(quotes.find((quote) => quote.currency === "USDT")?.observedAt).toEqual(new Date("2026-09-25T11:59:00.000Z"));
    expect(quotes.every((quote) => quote.source === "coinmarketcap")).toBe(true);
  });

  it("запрос: один вызов на обе валюты, id в адресе, ключ в заголовке, тариф Basic", async () => {
    const { source: cmc, calls } = source();
    await cmc.fetch(signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=11419,825&convert=USD");
    expect(calls[0]?.headers).toMatchObject({ "X-CMC_PRO_API_KEY": KEY });
    expect(cmc.id).toBe("coinmarketcap");
    expect(cmc.tariff).toBe(COINMARKETCAP_TARIFF);
    expect(COINMARKETCAP_TARIFF).toEqual({ name: "basic", perMinute: 30, perMonth: 10_000, minIntervalMs: 5 * 60_000 });
  });

  it("ответ без одной валюты — котировка только по второй", () => {
    const body = JSON.parse(Buffer.from(fixture("coinmarketcap-quotes.json")).toString("utf8")) as { data: Record<string, unknown> };
    delete body.data["11419"];
    const quotes = parseCoinMarketCap(body, NOW);
    expect(quotes.map((quote) => quote.currency)).toEqual(["USDT"]);
  });

  it("посторонний жетон с тикером GRAM под чужим id не подменяет Gram", () => {
    const body = JSON.parse(Buffer.from(fixture("coinmarketcap-quotes.json")).toString("utf8")) as { data: Record<string, unknown> };
    body.data["99999"] = { id: 99999, symbol: "GRAM", quote: { USD: { price: 0.004, last_updated: "2026-09-25T11:59:00.000Z" } } };
    const quotes = parseCoinMarketCap(body, NOW);
    expect(quotes.filter((quote) => quote.currency === "GRAM").map((quote) => quote.usdPerUnit.toString())).toEqual(["1.4301"]);
  });

  it("ответ — запись в массиве (так отвечает запрос по тикеру) тоже читается", () => {
    const body = { data: { "11419": [{ id: 11419, quote: { USD: { price: 1.5, last_updated: "2026-09-25T11:58:30.000Z" } } }] } };
    expect(usd(parseCoinMarketCap(body, NOW), "GRAM")).toBe("1.5");
  });

  it("нет last_updated — котировка на момент ответа", () => {
    const body = { data: { "825": { id: 825, quote: { USD: { price: 1 } } } } };
    expect(parseCoinMarketCap(body, NOW)[0]?.observedAt).toEqual(NOW);
  });

  it("429 — лимит с Retry-After; не тот формат и нулевая цена — недоступен", async () => {
    await expect(source("{}", { status: 429, headers: { "retry-after": "60" } }).source.fetch(signal)).rejects.toMatchObject({ name: "SourceRateLimitedError", retryAfterMs: 60_000 });
    await expect(source(JSON.stringify({ status: { error_code: 1001 } })).source.fetch(signal)).rejects.toThrow(/не того формата/);
    await expect(source("не json").source.fetch(signal)).rejects.toThrow(/не JSON/);
    expect(() => parseCoinMarketCap({ data: { "825": { id: 825, quote: { USD: { price: 0 } } } } }, NOW)).toThrow(/не того формата|должна быть больше нуля|price/);
  });
});

describe("tonapi и erapi: ключ необязателен", () => {
  it("tonapi без ключа — как прежде: тот же адрес, без заголовка авторизации, тариф без ключа", async () => {
    const served = answering(fixture("tonapi-rates.json"));
    const keyless = createTonApiSource({ ...served, now: () => NOW });
    await keyless.fetch(signal);
    expect(keyless.tariff).toBe(TONAPI_TARIFFS.keyless);
    expect(served.calls[0]?.url).toBe("https://tonapi.io/v2/rates?tokens=ton&currencies=usd");
    expect(served.calls[0]?.headers).not.toHaveProperty("Authorization");
  });

  it("tonapi с ключом — тот же адрес, заголовок Bearer и тариф «с ключом»", async () => {
    const served = answering(fixture("tonapi-rates.json"));
    const keyed = createTonApiSource({ ...served, key: "AFTONKEY123456789", now: () => NOW });
    const quotes = await keyed.fetch(signal);
    expect(usd(quotes, "GRAM")).toBe("1.426857314");
    expect(keyed.tariff).toBe(TONAPI_TARIFFS.keyed);
    expect(keyed.tariff.name).toBe("keyed");
    expect(served.calls[0]?.url).toBe("https://tonapi.io/v2/rates?tokens=ton&currencies=usd");
    expect(served.calls[0]?.headers).toMatchObject({ Authorization: "Bearer AFTONKEY123456789" });
  });

  it("erapi без ключа — открытый адрес и тариф открытого доступа", async () => {
    const served = answering(fixture("erapi-latest.json"));
    const open = createErApiSource(served);
    await open.fetch(signal);
    expect(open.tariff).toBe(ERAPI_TARIFFS.open);
    expect(served.calls[0]?.url).toBe("https://open.er-api.com/v6/latest/USD");
  });

  // Фикстура erapi-v6-latest.json собрана по документации ExchangeRate-API, а не снята
  // с источника: заменить снятой, когда будет ключ (в ответе с ключом курсы лежат в
  // `conversion_rates`, у открытого адреса — в `rates`).
  it("erapi с ключом — адрес v6 с ключом в пути, тариф «с ключом» (1 500 в месяц), курсы читаются из ответа с ключом", async () => {
    const served = answering(fixture("erapi-v6-latest.json"));
    const keyed = createErApiSource({ ...served, key: "0123456789abcdef01234567" });
    const quotes = await keyed.fetch(signal);
    expect(served.calls[0]?.url).toBe("https://v6.exchangerate-api.com/v6/0123456789abcdef01234567/latest/USD");
    expect(keyed.tariff).toBe(ERAPI_TARIFFS.keyed);
    expect(ERAPI_TARIFFS.keyed.perMonth).toBe(1500);
    expect(quotes.map((quote) => quote.currency).sort()).toEqual(["EUR", "RUB"]);
    expect(new Decimal(usd(quotes, "RUB") ?? "0").mul("84.485696").toDecimalPlaces(20).toString()).toBe("1");
    expect(quotes[0]?.observedAt).toEqual(new Date("2026-09-25T00:02:31Z"));
  });

  it("ключ erapi с чужими знаками в адрес не попадает: источник отказывается собраться", () => {
    expect(() => createErApiSource({ fetch: answering("{}").fetch, key: "abc/../x" })).toThrow(/ключ/);
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
