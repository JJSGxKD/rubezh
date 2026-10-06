/**
 * Валюты модуля курсов (docs/35-stage4-plan.md, §3.12, Р35).
 *
 * **Код** — ISO 4217 у фиата, тикер у крипты, `XTR` у звёзд Telegram. Код —
 * наш идентификатор, а не ключ поиска у источника: у каждого источника своя
 * метка валюты, и сопоставляется она по ней (`sources.ts`). Тикер GRAM с 2024
 * года носит и посторонний жетон в сети TON (docs/08-web-and-identity.md §6):
 * поиск по тикеру однажды взял бы его курс.
 *
 * **Разрядность** — сколько минорных единиц в одной: копейки у рубля,
 * нанограммы у Gram, у звёзд дробных нет вовсе. От неё зависят хранение
 * сумм целыми и округление цены.
 */

export const CURRENCY_KINDS = ["fiat", "crypto", "platform"] as const;

/**
 * - `fiat` — государственные валюты: курс официальный, меняется раз в сутки;
 * - `crypto` — рынок, курс волатилен и берётся медианой нескольких источников;
 * - `platform` — валюты площадок: звёзды, голоса. Рынка у них нет, курс
 *   задаётся руками и имеет срок годности.
 */
export type CurrencyKind = (typeof CURRENCY_KINDS)[number];

export interface Currency {
  code: string;
  kind: CurrencyKind;
  /** минорных единиц в единице — степень десятки */
  decimals: number;
  /** прежние названия — показываются рядом, пока их помнят игроки */
  formerNames: readonly string[];
}

export const CURRENCIES = {
  USD: { code: "USD", kind: "fiat", decimals: 2, formerNames: [] },
  EUR: { code: "EUR", kind: "fiat", decimals: 2, formerNames: [] },
  RUB: { code: "RUB", kind: "fiat", decimals: 2, formerNames: [] },
  // Нативная монета сети TON: в июне 2026 переименована из Toncoin обратно в
  // Gram, сеть по-прежнему TON. Разрядность — нанограммы.
  GRAM: { code: "GRAM", kind: "crypto", decimals: 9, formerNames: ["TON", "Toncoin"] },
  // USDT в сети TON — жетон с шестью знаками, как и в большинстве сетей.
  USDT: { code: "USDT", kind: "crypto", decimals: 6, formerNames: [] },
  XTR: { code: "XTR", kind: "platform", decimals: 0, formerNames: [] },
} as const satisfies Record<string, Currency>;

export type CurrencyCode = keyof typeof CURRENCIES;

/** Опорная валюта: курс любой валюты — цена её единицы в долларах. */
export const BASE_CURRENCY: CurrencyCode = "USD";

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}

export function currency(code: CurrencyCode): Currency {
  return CURRENCIES[code];
}
