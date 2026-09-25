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

/** Без ключа — секунда на запрос; курс DEX меняется быстрее, но нам хватит пяти минут. */
const TONAPI_TARIFF: Tariff = { name: "keyless", perMinute: 60, perMonth: null, minIntervalMs: 5 * MINUTE };

/** Метка TON API — токен `ton`: нативная монета сети, какое бы имя у неё ни было. */
export const TONAPI_CURRENCIES: readonly SourceCurrency[] = [{ currency: "GRAM", sourceId: "ton" }];

const tonapiSchema = z.object({
  rates: z.record(z.string(), z.object({ prices: z.object({ USD: z.number().positive() }) })),
});

export function createTonApiSource(options: { fetch: FetchLike; now?: () => Date }): RateSource {
  const now = options.now ?? (() => new Date());
  return {
    id: "tonapi",
    currencies: TONAPI_CURRENCIES,
    tariff: TONAPI_TARIFF,
    async fetch(signal) {
      return parseTonApi(await fetchJson(options.fetch, "tonapi", "https://tonapi.io/v2/rates?tokens=ton&currencies=usd", signal, tonapiSchema), now());
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
