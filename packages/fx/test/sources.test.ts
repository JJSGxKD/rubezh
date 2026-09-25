import { describe, expect, it } from "vitest";
import { StubHttpClient } from "../src/ports/http.js";
import { resolvePlan } from "../src/rates/planner.js";
import { SourceError, type SourceDefinition, type SourceQuote } from "../src/rates/source.js";
import { binanceSource, cbrSource, coingeckoSource, DEFAULT_SOURCES, ecbSource, findSourceProblems, openErApiSource, tonapiSource } from "../src/rates/sources/index.js";
import { BINANCE_JSON, CBR_XML, COINGECKO_JSON, ECB_XML, OPEN_ER_API_JSON, TONAPI_JSON } from "./fixtures/source-responses.js";

// Адаптеры источников (docs/35-stage4-plan.md §3.12): валюта сопоставляется
// по идентификатору источника, а не по тикеру; курс приводится к одному
// соглашению — доллары за единицу; отказы источника различаются по виду.

const NOW = Date.UTC(2026, 8, 25, 12);

async function fetchWith(source: SourceDefinition, body: string, options: { apiKey?: string; currencies?: SourceQuote["currency"][]; status?: number } = {}) {
  const http = new StubHttpClient();
  const resolved = resolvePlan(source, options.apiKey);
  http.answer(resolved.plan.baseUrl, { status: options.status ?? 200, body });
  const quotes = await source.fetch({
    http,
    plan: resolved.plan,
    apiKey: resolved.apiKey,
    currencies: options.currencies ?? (Object.keys(source.currencies) as SourceQuote["currency"][]),
    timeoutMs: 1000,
    now: NOW,
  });
  return { quotes, http };
}

function byCurrency(quotes: SourceQuote[]): Record<string, string> {
  return Object.fromEntries(quotes.map((quote) => [quote.currency, quote.price.toString()]));
}

describe("реестр источников", () => {
  it("проходит проверку и покрывает каждую собираемую валюту хотя бы двумя источниками", () => {
    expect(findSourceProblems(DEFAULT_SOURCES)).toEqual([]);
    for (const code of ["RUB", "EUR", "GRAM", "USDT"] as const) {
      const covering = DEFAULT_SOURCES.filter((source) => source.currencies[code] !== undefined);
      expect(covering.length, code).toBeGreaterThanOrEqual(2);
    }
  });

  it("называет источник и поле в ошибке", () => {
    const broken: SourceDefinition = { ...cbrSource, id: "cbr", currencies: {}, naturalIntervalMs: 0, free: { ...cbrSource.free, baseUrl: "http://x" }, paid: { name: "paid", baseUrl: "https://x", limits: { requestsPerMinute: 0, requestsPerMonth: -1 } } };
    const problems = findSourceProblems([cbrSource, broken]);
    expect(problems).toContain("источник cbr: идентификатор повторяется");
    expect(problems).toContain("источник cbr: не умеет ни одной валюты");
    expect(problems).toContain("источник cbr: природный интервал должен быть больше нуля");
    expect(problems).toContain("источник cbr: адрес тарифа free не https");
    expect(problems).toContain("источник cbr: лимит в минуту тарифа paid не положителен");
    expect(problems).toContain("источник cbr: лимит в месяц тарифа paid не положителен");
    expect(problems).toContain("источник cbr: у платного тарифа не указан заголовок ключа");
  });
});

describe("ЦБ РФ", () => {
  it("переводит рубли за доллар в доллары за рубль и евро через доллар, по ID валюты", async () => {
    const { quotes } = await fetchWith(cbrSource, CBR_XML);
    expect(byCurrency(quotes)).toEqual({ RUB: "0.010810810810810811", EUR: "1.08" });
    expect(quotes.map((quote) => quote.sourceCurrencyId)).toEqual(["R01235", "R01239"]);
    expect(quotes.every((quote) => quote.quotedIn === "USD" && quote.observedAt === NOW)).toBe(true);
  });

  it("спрашивает только нужные валюты и различает виды отказов", async () => {
    const { quotes } = await fetchWith(cbrSource, CBR_XML, { currencies: ["RUB", "GRAM"] });
    expect(quotes.map((quote) => quote.currency)).toEqual(["RUB"]);

    await expect(fetchWith(cbrSource, CBR_XML.replace('ID="R01235"', 'ID="R00000"'))).rejects.toMatchObject({ kind: "missing" });
    await expect(fetchWith(cbrSource, "", { status: 429 })).rejects.toMatchObject({ kind: "rate_limited", status: 429 });
    await expect(fetchWith(cbrSource, "", { status: 503 })).rejects.toMatchObject({ kind: "http", status: 503 });
    await expect(fetchWith(cbrSource, "<html>вход только по паролю</html>")).rejects.toBeInstanceOf(SourceError);
  });
});

describe("ЕЦБ и запасной форекс", () => {
  it("берёт курс евро из строки USD и не притворяется, что знает рубль", async () => {
    const { quotes } = await fetchWith(ecbSource, ECB_XML, { currencies: ["EUR", "RUB"] });
    expect(byCurrency(quotes)).toEqual({ EUR: "1.0812" });
    await expect(fetchWith(ecbSource, ECB_XML.replace("currency='USD'", "currency='XXX'"))).rejects.toMatchObject({ kind: "missing" });
  });

  it("запасной источник обращает «единиц за доллар» и отвергает чужой ответ", async () => {
    const { quotes } = await fetchWith(openErApiSource, OPEN_ER_API_JSON);
    expect(byCurrency(quotes)).toEqual({ RUB: "0.010810810810810811", EUR: "1.081081081081081081" });
    await expect(fetchWith(openErApiSource, JSON.stringify({ result: "error", rates: {} }))).rejects.toMatchObject({ kind: "http" });
    await expect(fetchWith(openErApiSource, "не json")).rejects.toMatchObject({ kind: "parse" });
    await expect(fetchWith(openErApiSource, JSON.stringify({ result: "success", rates: { EUR: 0.9 } }))).rejects.toMatchObject({ kind: "missing" });
  });
});

describe("крипта", () => {
  it("CoinGecko: посторонняя монета с id «gram» не подменяет курс Gram", async () => {
    const { quotes, http } = await fetchWith(coingeckoSource, COINGECKO_JSON);
    expect(byCurrency(quotes)).toEqual({ GRAM: "3.21", USDT: "0.9998" });
    expect(quotes.find((quote) => quote.currency === "GRAM")?.sourceCurrencyId).toBe("the-open-network");
    expect(http.requests[0]?.url).toBe("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network,tether&vs_currencies=usd");
    expect(http.requests[0]?.headers).toBeUndefined();
  });

  it("CoinGecko: ключ переключает адрес и заголовок платного тарифа", async () => {
    const { http } = await fetchWith(coingeckoSource, COINGECKO_JSON, { apiKey: "secret-key" });
    expect(http.requests[0]?.url.startsWith("https://pro-api.coingecko.com/api/v3/")).toBe(true);
    expect(http.requests[0]?.headers).toEqual({ "x-cg-pro-api-key": "secret-key" });
    await expect(fetchWith(coingeckoSource, JSON.stringify({ tether: { usd: 1 } }))).rejects.toMatchObject({ kind: "missing" });
    await expect(fetchWith(coingeckoSource, JSON.stringify({ tether: { usd: -1 } }))).rejects.toMatchObject({ kind: "parse" });
  });

  it("TON API: монета по имени, жетон по адресу, посторонний жетон не участвует", async () => {
    const { quotes } = await fetchWith(tonapiSource, TONAPI_JSON);
    expect(byCurrency(quotes)).toEqual({ GRAM: "3.2", USDT: "0.9997" });
    expect(quotes.map((quote) => quote.sourceCurrencyId)).toEqual(["ton", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"]);
    const { http } = await fetchWith(tonapiSource, TONAPI_JSON, { apiKey: "tok" });
    expect(http.requests[0]?.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("Binance котирует в USDT и помечает это, а цену читает строкой без float", async () => {
    const { quotes } = await fetchWith(binanceSource, BINANCE_JSON);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ currency: "GRAM", sourceCurrencyId: "TONUSDT", quotedIn: "USDT" });
    expect(quotes[0]?.price.toString()).toBe("3.195");
    await expect(fetchWith(binanceSource, JSON.stringify([{ symbol: "TONUSDT", price: "0" }]))).rejects.toMatchObject({ kind: "parse" });
    await expect(fetchWith(binanceSource, JSON.stringify([]))).rejects.toMatchObject({ kind: "missing" });
  });
});
