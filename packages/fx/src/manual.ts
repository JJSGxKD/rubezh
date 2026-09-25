import type { CurrencyCode } from "./currencies.js";
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
 */

export const MANUAL_RATE_PURPOSES = ["price", "payout"] as const;

export type ManualRatePurpose = (typeof MANUAL_RATE_PURPOSES)[number];

export interface ManualRate {
  currency: CurrencyCode;
  purpose: ManualRatePurpose;
  usdPerUnit: Decimal;
  /** кто поставил — для аудита */
  setBy: string;
  setAt: Date;
  expiresAt: Date;
  note: string;
}

export function manualRate(input: Omit<ManualRate, "usdPerUnit"> & { usdPerUnit: DecimalInput }): ManualRate {
  if (input.expiresAt <= input.setAt) throw new RangeError("срок годности курса — позже момента, когда его поставили");
  return { ...input, usdPerUnit: positive(input.usdPerUnit, `курс ${input.currency}`) };
}

/**
 * Курс для снимка. `observedAt` — конец срока годности: свежесть заданного
 * курса считается от него (`FRESHNESS_POLICY.platform`).
 */
export function manualToRate(rate: ManualRate): Rate {
  return { currency: rate.currency, usdPerUnit: rate.usdPerUnit, sources: [`manual:${rate.setBy}`], observedAt: rate.expiresAt };
}
