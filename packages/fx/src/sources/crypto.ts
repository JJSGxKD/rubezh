import { z } from "zod";
import type { Tariff } from "../budget.js";
import type { CurrencyCode } from "../currencies.js";
import { quoteInUsd, type Quote } from "../quote.js";
import { SourceUnavailableError, matchBySourceId, type RateSource, type SourceCurrency } from "../sources.js";
import { fetchJson, type FetchLike } from "./http.js";

/**
 * Курсы крипты (docs/35-stage4-plan.md, §3.12, Р35): Gram — единственная
 * волатильная валюта, поэтому у неё три независимых голоса — агрегатор, DEX и
 * биржа, — и медиана по ним.
 *
 * - **CoinGecko** — агрегатор. Метка Gram — `the-open-network`: при
 *   переименовании в июне 2026 идентификатор остался прежним, а тикер GRAM
 *   носит и посторонний жетон. Без ключа — общий лимит по адресу, с
 *   бесплатным демо-ключом — свой месячный, с платным — другой адрес;
 * - **TON API** — цена по пулам ликвидности DEX сети (Stonfi, DeDust и
 *   другие). Сам сервис предупреждает, что курс — для показа, а не для
 *   расчётов: поэтому он голос медианы, а не единственный источник;
 * - **CoinMarketCap** — второй агрегатор, запас на случай, если CoinGecko
 *   исчерпает лимит или ляжет (Р89). Работает только с ключом: без него его
 *   нет в списке источников. Валюты — по числовым id, а не по тикерам: тикер
 *   Toncoin менялся (`GRAM` с июня 2026), а id остаётся;
 * - **Binance** — пара GRAM/USDT (торгуется со 2 июля 2026 вместо TON/USDT).
 *   Цена — в USDT: он держится у доллара с отклонением в доли процента, а
 *   согласие источников — 3%, так что пересчёт через курс USDT сдвинул бы
 *   голос меньше, чем его погрешность.
 */

const MINUTE = 60_000;

export type CoinGeckoKey = { plan: "demo" | "pro"; value: string };

/**
 * Тариф по ключу. Лимиты демо-тарифа — из документации CoinGecko на сентябрь
 * 2026: 100 в минуту и 10 000 в месяц; в минуту берём с запасом, месяц
 * планировщик растянет сам. Без ключа лимит общий на адрес и плавает —
 * опрос раз в пять минут. Платный — ступень Analyst.
 */
export const COINGECKO_TARIFFS: Record<"keyless" | CoinGeckoKey["plan"], Tariff> = {
  keyless: { name: "keyless", perMinute: 5, perMonth: null, minIntervalMs: 5 * MINUTE },
  demo: { name: "demo", perMinute: 30, perMonth: 10_000, minIntervalMs: 5 * MINUTE },
  pro: { name: "pro", perMinute: 500, perMonth: 500_000, minIntervalMs: MINUTE },
};

export const COINGECKO_CURRENCIES: readonly SourceCurrency[] = [
  { currency: "GRAM", sourceId: "the-open-network" },
  { currency: "USDT", sourceId: "tether" },
];

const coingeckoSchema = z.record(z.string(), z.object({ usd: z.number().positive(), last_updated_at: z.number().int().positive().optional() }));

export function createCoinGeckoSource(options: { fetch: FetchLike; key?: CoinGeckoKey; now?: () => Date }): RateSource {
  const plan = options.key?.plan ?? "keyless";
  const host = plan === "pro" ? "https://pro-api.coingecko.com" : "https://api.coingecko.com";
  const headers: Record<string, string> = options.key === undefined ? {} : { [`x-cg-${options.key.plan}-api-key`]: options.key.value };
  const ids = COINGECKO_CURRENCIES.map((entry) => entry.sourceId).join(",");
  const now = options.now ?? (() => new Date());
  return {
    id: "coingecko",
    currencies: COINGECKO_CURRENCIES,
    tariff: COINGECKO_TARIFFS[plan],
    async fetch(signal) {
      const url = `${host}/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_last_updated_at=true`;
      return parseCoinGecko(await fetchJson(options.fetch, "coingecko", url, signal, coingeckoSchema, headers), now());
    },
  };
}

export function parseCoinGecko(body: z.infer<typeof coingeckoSchema>, now: Date): Quote[] {
  const matched = matchBySourceId(COINGECKO_CURRENCIES, Object.entries(body));
  return [...matched].map(([code, entry]: [CurrencyCode, { usd: number; last_updated_at?: number | undefined }]) =>
    quoteInUsd(code, entry.usd, "coingecko", entry.last_updated_at === undefined ? now : new Date(entry.last_updated_at * 1000)),
  );
}

/**
 * Тариф CoinMarketCap «Basic»: 10 000 кредитов в месяц и 30 запросов в
 * минуту. Один опрос обеих валют — один кредит; раз в пять минут это около
 * 8 600 кредитов в месяц, под лимит. Числа — из условий тарифа на дату
 * задачи (tasks/T-0063); если поставщик их поменял, лимит правят в панели.
 */
export const COINMARKETCAP_TARIFF: Tariff = { name: "basic", perMinute: 30, perMonth: 10_000, minIntervalMs: 5 * MINUTE };

/** Метки CoinMarketCap — числовые id (`/v1/cryptocurrency/map`): Toncoin — 11419, Tether — 825. */
export const COINMARKETCAP_CURRENCIES: readonly SourceCurrency[] = [
  { currency: "GRAM", sourceId: "11419" },
  { currency: "USDT", sourceId: "825" },
];

const cmcEntry = z.object({
  quote: z.object({ USD: z.object({ price: z.number().positive(), last_updated: z.string().optional() }) }),
});

/** Запрос по `id` отдаёт запись по ключу-id; по тикеру — массив: читаем оба вида. */
const coinMarketCapSchema = z.object({ data: z.record(z.string(), z.union([cmcEntry, z.array(cmcEntry).min(1)])) });

export function createCoinMarketCapSource(options: { fetch: FetchLike; key: string; now?: () => Date }): RateSource {
  const now = options.now ?? (() => new Date());
  const ids = COINMARKETCAP_CURRENCIES.map((entry) => entry.sourceId).join(",");
  return {
    id: "coinmarketcap",
    currencies: COINMARKETCAP_CURRENCIES,
    tariff: COINMARKETCAP_TARIFF,
    async fetch(signal) {
      const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=${ids}&convert=USD`;
      const body = await fetchJson(options.fetch, "coinmarketcap", url, signal, z.unknown(), { "X-CMC_PRO_API_KEY": options.key });
      return parseCoinMarketCap(body, now());
    },
  };
}

/**
 * Котировки по `data[id].quote.USD.price`. Время — `last_updated` самой
 * котировки; нет его — момент ответа. Чужой id с тикером GRAM не берётся.
 */
export function parseCoinMarketCap(body: unknown, now: Date): Quote[] {
  const parsed = coinMarketCapSchema.safeParse(body);
  if (!parsed.success) throw new SourceUnavailableError("coinmarketcap", "ответ не того формата");
  const entries = Object.entries(parsed.data.data).flatMap(([id, value]): [string, z.infer<typeof cmcEntry>][] => {
    const entry = Array.isArray(value) ? value[0] : value;
    return entry === undefined ? [] : [[id, entry]];
  });
  return [...matchBySourceId(COINMARKETCAP_CURRENCIES, entries)].map(([code, entry]: [CurrencyCode, z.infer<typeof cmcEntry>]) => {
    const updated = entry.quote.USD.last_updated === undefined ? Number.NaN : Date.parse(entry.quote.USD.last_updated);
    return quoteInUsd(code, entry.quote.USD.price, "coinmarketcap", Number.isNaN(updated) ? now : new Date(updated));
  });
}

/**
 * Тариф TON API. Без ключа — секунда на запрос; курс DEX меняется быстрее, но
 * нам хватит пяти минут. С ключом лимит у сервиса выше, а наш опрос прежний:
 * числа лимита с ключом не сверены с документацией (tasks/T-0063, вопрос в PR) —
 * они правятся в панели.
 */
export const TONAPI_TARIFFS: Record<"keyless" | "keyed", Tariff> = {
  keyless: { name: "keyless", perMinute: 60, perMonth: null, minIntervalMs: 5 * MINUTE },
  keyed: { name: "keyed", perMinute: 60, perMonth: null, minIntervalMs: 5 * MINUTE },
};

/** Метка TON API — токен `ton`: нативная монета сети, какое бы имя у неё ни было. */
export const TONAPI_CURRENCIES: readonly SourceCurrency[] = [{ currency: "GRAM", sourceId: "ton" }];

const tonapiSchema = z.object({
  rates: z.record(z.string(), z.object({ prices: z.object({ USD: z.number().positive() }) })),
});

/** Ключ необязателен: с ним тот же адрес, заголовок `Authorization: Bearer` и тариф с ключом. */
export function createTonApiSource(options: { fetch: FetchLike; key?: string; now?: () => Date }): RateSource {
  const now = options.now ?? (() => new Date());
  const headers: Record<string, string> = options.key === undefined ? {} : { Authorization: `Bearer ${options.key}` };
  return {
    id: "tonapi",
    currencies: TONAPI_CURRENCIES,
    tariff: options.key === undefined ? TONAPI_TARIFFS.keyless : TONAPI_TARIFFS.keyed,
    async fetch(signal) {
      return parseTonApi(await fetchJson(options.fetch, "tonapi", "https://tonapi.io/v2/rates?tokens=ton&currencies=usd", signal, tonapiSchema, headers), now());
    },
  };
}

/** Ключ в ответе — прописными (`TON`), хотя спрашивали `ton`. Метки времени нет — котировка на момент ответа. */
export function parseTonApi(body: z.infer<typeof tonapiSchema>, now: Date): Quote[] {
  const entries = Object.entries(body.rates).map(([token, entry]): [string, number] => [token.toLowerCase(), entry.prices.USD]);
  return [...matchBySourceId(TONAPI_CURRENCIES, entries)].map(([code, usd]) => quoteInUsd(code, usd, "tonapi", now));
}

const BINANCE_TARIFF: Tariff = { name: "public", perMinute: 60, perMonth: null, minIntervalMs: 5 * MINUTE };

export const BINANCE_CURRENCIES: readonly SourceCurrency[] = [{ currency: "GRAM", sourceId: "GRAMUSDT" }];

const binanceSchema = z.object({ symbol: z.string(), price: z.string().regex(/^\d+(\.\d+)?$/) });

export function createBinanceSource(options: { fetch: FetchLike; now?: () => Date }): RateSource {
  const now = options.now ?? (() => new Date());
  const [pair] = BINANCE_CURRENCIES;
  if (pair === undefined) throw new Error("у Binance нет пары");
  return {
    id: "binance",
    currencies: BINANCE_CURRENCIES,
    tariff: BINANCE_TARIFF,
    async fetch(signal) {
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair.sourceId}`;
      return parseBinance(await fetchJson(options.fetch, "binance", url, signal, binanceSchema), now());
    },
  };
}

export function parseBinance(body: z.infer<typeof binanceSchema>, now: Date): Quote[] {
  const matched = matchBySourceId(BINANCE_CURRENCIES, [[body.symbol, body.price]]);
  if (matched.size === 0) throw new SourceUnavailableError("binance", `ответ про чужую пару ${body.symbol}`);
  return [...matched].map(([code, price]) => quoteInUsd(code, price, "binance", now));
}
