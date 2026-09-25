import type { CurrencyCode } from "../currency.js";
import type { Decimal } from "../decimal.js";

/**
 * Курс — в одном соглашении: **цена одной единицы валюты в опорной валюте**
 * (доллар), `Decimal`. У фиата, крипты и звёзд — одно и то же поле с одним
 * смыслом. В источнике переноса у фиата было «сколько долларов стоит
 * единица», у крипты — «сколько единиц за доллар», и различал их тип валюты;
 * это уже однажды дало ошибку пересчёта (docs/35-stage4-plan.md §3.12) —
 * второй раз её не воспроизводим.
 */

/** Сколько знаков после запятой держим у курса: 1/92.1234 в 18 знаках — погрешность 1e-16, копейки не теряются. */
export const RATE_SCALE = 18;

/**
 * Назначение курса. У звёзд их два, и путать их нельзя: сколько платит
 * игрок (`price`) и сколько получаем мы при выводе (`revenue`). У рыночных
 * валют оба совпадают, и хранится только `price`.
 */
export type RatePurpose = "price" | "revenue";

/** Одно значение от одного источника. История наблюдений — только добавлением. */
export interface RateObservation {
  currency: CurrencyCode;
  sourceId: string;
  /** Идентификатор валюты у источника: по нему сопоставляли, хранится для разбора спорных случаев. */
  sourceCurrencyId: string;
  usdPerUnit: Decimal;
  /** мс UTC */
  observedAt: number;
}

/**
 * Принятый курс — итог сбора для валюты: медиана или приоритетный источник,
 * прошедший проверку скачка, либо заданный руками курс. Именно по нему
 * строятся снимки.
 */
export interface AcceptedRate {
  currency: CurrencyCode;
  purpose: RatePurpose;
  usdPerUnit: Decimal;
  /** Из чего собран: идентификаторы источников; у заданного — `fixed`. */
  sources: readonly string[];
  /** мс UTC — когда принят; свежесть считается от этого момента. */
  acceptedAt: number;
  /** Задан руками, а не собран с рынка. */
  fixed: boolean;
  /** У заданного курса — срок годности; после него курс устарел, каким бы свежим ни был `acceptedAt`. */
  validUntil?: number;
}

export function rateKey(currency: CurrencyCode, purpose: RatePurpose): string {
  return `${currency}:${purpose}`;
}
