import { BASE_CURRENCY, type CurrencyCode } from "./currencies.js";
import { Decimal, positive, type DecimalInput } from "./decimal.js";

/**
 * Котировка — то, что сказал один источник об одной валюте, уже приведённое
 * к единому соглашению: цена единицы в долларах. Курсом она становится,
 * только пройдя проверки (`accept.ts`).
 */
export interface Quote {
  currency: CurrencyCode;
  usdPerUnit: Decimal;
  source: string;
  observedAt: Date;
}

/**
 * Источник назвал цены в своей валюте — ЦБ в рублях, ЕЦБ в евро. Цена
 * доллара в той же валюте переводит их в соглашение модуля:
 * `usdPerUnit(X) = цена(X) / цена(USD)`, а у самой валюты источника —
 * `1 / цена(USD)`. У источника (`vpnsibcom_api`) то же деление было, но
 * числами с плавающей точкой; ноль в цене доллара ронял бы весь пересчёт —
 * здесь он отвергается на входе.
 *
 * `prices` — цена **одной** единицы: номинал («за 100 иен» у ЦБ) адаптер
 * делит сам, до этой функции.
 */
export function quotesViaHome(input: {
  home: CurrencyCode;
  /** цена одной единицы валюты в валюте источника */
  prices: ReadonlyMap<CurrencyCode, DecimalInput>;
  source: string;
  observedAt: Date;
}): Quote[] {
  const usdPrice = input.prices.get(BASE_CURRENCY);
  if (usdPrice === undefined) throw new RangeError(`${input.source}: в ответе нет цены доллара — пересчитать не через что`);
  const usdInHome = positive(usdPrice, `${input.source}: цена USD`);

  const quotes: Quote[] = [];
  if (input.home !== BASE_CURRENCY) {
    quotes.push({ currency: input.home, usdPerUnit: new Decimal(1).div(usdInHome), source: input.source, observedAt: input.observedAt });
  }
  for (const [code, price] of input.prices) {
    if (code === BASE_CURRENCY || code === input.home) continue;
    quotes.push({ currency: code, usdPerUnit: positive(price, `${input.source}: цена ${code}`).div(usdInHome), source: input.source, observedAt: input.observedAt });
  }
  return quotes;
}

/** Источник назвал цену единицы прямо в долларах — агрегаторы крипты. */
export function quoteInUsd(currency: CurrencyCode, usd: DecimalInput, source: string, observedAt: Date): Quote {
  return { currency, usdPerUnit: positive(usd, `${source}: цена ${currency}`), source, observedAt };
}

/**
 * Источник назвал, сколько единиц дают за доллар, — так принято у звёзд и
 * части бирж. Разворачивается здесь, один раз: второго соглашения за
 * пределами адаптера не существует.
 */
export function quoteFromUnitsPerUsd(currency: CurrencyCode, unitsPerUsd: DecimalInput, source: string, observedAt: Date): Quote {
  return { currency, usdPerUnit: new Decimal(1).div(positive(unitsPerUsd, `${source}: единиц ${currency} за доллар`)), source, observedAt };
}
