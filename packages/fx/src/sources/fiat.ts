import { z } from "zod";
import type { Tariff } from "../budget.js";
import type { CurrencyCode } from "../currencies.js";
import { Decimal } from "../decimal.js";
import { quoteFromUnitsPerUsd, quotesViaHome, type Quote } from "../quote.js";
import { SourceUnavailableError, matchBySourceId, type RateSource, type SourceCurrency } from "../sources.js";
import { fetchBytes, fetchJson, type FetchLike } from "./http.js";

/**
 * Официальные курсы фиата (docs/35-stage4-plan.md, §3.12, Р35): курс меняется
 * раз в рабочий день, поэтому источник опрашивается раз в несколько часов —
 * чаще незачем, а реже можно пропустить публикацию на сутки.
 *
 * - **ЦБ РФ** — рубль. Без ключа и без лимита, ответ — XML в windows-1251,
 *   цена за номинал («за 100 иен»);
 * - **ЕЦБ** — евро и доллар. Рубля у ЕЦБ нет с марта 2022 года;
 * - **ExchangeRate-API**, открытый доступ, — запасной для всего фиата: без
 *   ключа, обновление раз в сутки, `429` на двадцать минут при злоупотреблении.
 *   Условия: при показе курсов — ссылка «Rates By Exchange Rate API», данные
 *   нельзя перераспространять. Мы их не показываем и не раздаём, а берём
 *   одним из голосов медианы.
 */

const HOUR = 3_600_000;

const OFFICIAL_TARIFF: Tariff = { name: "official", perMinute: 1, perMonth: null, minIntervalMs: 4 * HOUR };
const ERAPI_TARIFF: Tariff = { name: "open-access", perMinute: 1, perMonth: null, minIntervalMs: 12 * HOUR };

/** Момент котировки фиату даёт сам источник — дата курса, — часы ему не нужны. */
interface SourceOptions {
  fetch: FetchLike;
}

/** Метка ЦБ — буквенный код (`CharCode`): для фиата он однозначен. */
export const CBR_CURRENCIES: readonly SourceCurrency[] = [
  { currency: "USD", sourceId: "USD" },
  { currency: "EUR", sourceId: "EUR" },
];

export function createCbrSource(options: SourceOptions): RateSource {
  return {
    id: "cbr",
    currencies: [...CBR_CURRENCIES, { currency: "RUB", sourceId: "RUB" }],
    tariff: OFFICIAL_TARIFF,
    async fetch(signal) {
      const body = await fetchBytes(options.fetch, "cbr", "https://www.cbr.ru/scripts/XML_daily.asp", signal);
      return parseCbr(new TextDecoder("windows-1251").decode(body));
    },
  };
}

/**
 * Дата курса ЦБ — день, с которого он действует; ставится накануне, поэтому
 * к вечеру ЦБ отдаёт завтрашний курс. Момент — полночь этого дня по Москве:
 * граница, с которой курс официальный.
 */
export function parseCbr(xml: string): Quote[] {
  const date = /<ValCurs[^>]*\bDate="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  if (date === null) throw new SourceUnavailableError("cbr", "нет даты курса");
  const observedAt = new Date(`${date[3]}-${date[2]}-${date[1]}T00:00:00+03:00`);

  const entries: [string, Decimal][] = [];
  for (const match of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)) {
    const inner = match[1] ?? "";
    const code = /<CharCode>([A-Z]{3})<\/CharCode>/.exec(inner)?.[1];
    const nominal = /<Nominal>(\d+)<\/Nominal>/.exec(inner)?.[1];
    const value = /<Value>([\d\s]+,\d+|\d+)<\/Value>/.exec(inner)?.[1];
    if (code === undefined || nominal === undefined || value === undefined) continue;
    entries.push([code, new Decimal(value.replace(/\s/g, "").replace(",", ".")).div(nominal)]);
  }

  const prices = matchBySourceId<Decimal>(CBR_CURRENCIES, entries);
  return quotesViaHome({ home: "RUB", prices, source: "cbr", observedAt });
}

export const ECB_CURRENCIES: readonly SourceCurrency[] = [{ currency: "USD", sourceId: "USD" }];

export function createEcbSource(options: SourceOptions): RateSource {
  return {
    id: "ecb",
    currencies: [...ECB_CURRENCIES, { currency: "EUR", sourceId: "EUR" }],
    tariff: OFFICIAL_TARIFF,
    async fetch(signal) {
      const body = await fetchBytes(options.fetch, "ecb", "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", signal);
      return parseEcb(new TextDecoder().decode(body));
    },
  };
}

/** У ЕЦБ курс — сколько единиц за один евро; цена единицы в евро — обратное. */
export function parseEcb(xml: string): Quote[] {
  const time = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (time === undefined) throw new SourceUnavailableError("ecb", "нет даты курса");

  const entries: [string, Decimal][] = [];
  for (const match of xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    entries.push([match[1] ?? "", new Decimal(1).div(match[2] ?? "0")]);
  }
  const prices = matchBySourceId<Decimal>(ECB_CURRENCIES, entries);
  return quotesViaHome({ home: "EUR", prices, source: "ecb", observedAt: new Date(`${time}T00:00:00Z`) });
}

export const ERAPI_CURRENCIES: readonly SourceCurrency[] = [
  { currency: "RUB", sourceId: "RUB" },
  { currency: "EUR", sourceId: "EUR" },
];

const erapiSchema = z.object({
  result: z.literal("success"),
  base_code: z.literal("USD"),
  time_last_update_unix: z.number().int().positive(),
  rates: z.record(z.string(), z.number().positive()),
});

export function createErApiSource(options: SourceOptions): RateSource {
  return {
    id: "erapi",
    currencies: ERAPI_CURRENCIES,
    tariff: ERAPI_TARIFF,
    async fetch(signal) {
      return parseErApi(await fetchJson(options.fetch, "erapi", "https://open.er-api.com/v6/latest/USD", signal, erapiSchema));
    },
  };
}

/** База — доллар, курс — сколько единиц за доллар. */
export function parseErApi(body: z.infer<typeof erapiSchema>): Quote[] {
  const observedAt = new Date(body.time_last_update_unix * 1000);
  const matched = matchBySourceId<number>(ERAPI_CURRENCIES, Object.entries(body.rates));
  return [...matched].map(([code, unitsPerUsd]: [CurrencyCode, number]) => quoteFromUnitsPerUsd(code, unitsPerUsd, "erapi", observedAt));
}

