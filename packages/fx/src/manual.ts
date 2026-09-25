import { BASE_CURRENCY, CURRENCIES, type CurrencyCode } from "./currencies.js";
import { positive, type Decimal, type DecimalInput } from "./decimal.js";
import type { Rate } from "./rates.js";

/**
 * Заданный курс — у валют площадок рынка нет (docs/35-stage4-plan.md,
 * §3.12). Звёзды, голоса VK: курс ставит человек в панели, с аудитом и
 * **сроком годности** — просроченный курс даёт алерт, а не устаревает молча.
 *
 * У звёзд два курса, и путать их нельзя: сколько за звезду платит игрок —
 * он нужен ценам, — и сколько получаем мы при выводе — он нужен выручке.
 * У источника (`vpnsibcom_api`, `tgStarsToUSD`) был один, и выручка
 * считалась по цене покупки.
 *
 * **Цена — в валюте котировки** (Р37). Выплату Telegram держит в долларах
 * ($0,013 за звезду), а цену для игрока — в рублях по прайс-листу клиента
 * (1,72 ₽). Заданная в рублях, она сама следует за курсом рубля: снимок
 * переводит её в доллары по принятому курсу, и заданный курс не приходится
 * переставлять руками каждый раз, когда сдвинулся рубль.
 */

export const MANUAL_RATE_PURPOSES = ["price", "payout"] as const;

export type ManualRatePurpose = (typeof MANUAL_RATE_PURPOSES)[number];

export interface ManualRate {
  currency: CurrencyCode;
  purpose: ManualRatePurpose;
  /** цена одной единицы в валюте котировки */
  price: Decimal;
  /** в чём задана цена — рыночная валюта, не валюта площадки */
  quote: CurrencyCode;
  /** кто поставил — для аудита */
  setBy: string;
  setAt: Date;
  expiresAt: Date;
  note: string;
}

export function manualRate(input: Omit<ManualRate, "price" | "quote"> & { price: DecimalInput; quote?: CurrencyCode }): ManualRate {
  const quote = input.quote ?? BASE_CURRENCY;
  if (input.expiresAt <= input.setAt) throw new RangeError("срок годности курса — позже момента, когда его поставили");
  // Котировка в валюте площадки замкнула бы курс звезды на курс голосов, у
  // которых рынка тоже нет, — считать их было бы не из чего.
  if (CURRENCIES[quote].kind === "platform") throw new RangeError(`курс ${input.currency} нельзя задать в ${quote}: у неё самой нет рынка`);
  return { ...input, quote, price: positive(input.price, `курс ${input.currency}`) };
}

/**
 * Курс для снимка: цена, переведённая в доллары по курсу котировки.
 * `quoteUsdPerUnit` — цена единицы котировки в долларах из того же снимка;
 * у доллара — единица. `observedAt` — конец срока годности: свежесть
 * заданного курса считается от него (`FRESHNESS_POLICY.platform`).
 */
export function manualToRate(rate: ManualRate, quoteUsdPerUnit: Decimal): Rate {
  const sources = rate.quote === BASE_CURRENCY ? [`manual:${rate.setBy}`] : [`manual:${rate.setBy}`, `via:${rate.quote}`];
  return { currency: rate.currency, usdPerUnit: rate.price.mul(quoteUsdPerUnit), sources, observedAt: rate.expiresAt };
}
