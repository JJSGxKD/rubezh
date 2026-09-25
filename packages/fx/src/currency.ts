import { Decimal } from "./decimal.js";

/**
 * Валюты и их свойства (docs/35-stage4-plan.md §3.12, Р35). Код — ISO 4217 у
 * фиата, тикер у крипты, `XTR` у звёзд Telegram; у валют площадок — свой код.
 * На старте шесть валют, новая — строка в `CURRENCIES` и код в `CURRENCY_CODES`.
 */

export const CURRENCY_CODES = ["USD", "EUR", "RUB", "XTR", "GRAM", "USDT"] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export type CurrencyKind = "fiat" | "crypto" | "platform";

export interface Currency {
  code: CurrencyCode;
  kind: CurrencyKind;
  /**
   * Разрядность в минорных единицах: рубль — 2 (копейки), Gram — 9
   * (нанотоны), USDT в сети TON — 6, звёзды — 0. Суммы в базе хранятся в
   * минорных единицах целыми, поэтому разрядность — свойство валюты, а не
   * места, где её показывают.
   */
  decimals: number;
  /** Имя для игрока — только ключ i18n: словарь подключается в оболочке. */
  nameKey: string;
  /**
   * Прежние коды. У Gram это TON: в июне 2026 монету сети переименовали, сеть
   * осталась TON (docs/08-web-and-identity.md §6). По прежнему коду
   * сопоставляются старые выгрузки и источники, которые ещё не переименовали.
   */
  formerCodes: readonly string[];
  /** У крипты — сеть: USDT в TON и USDT в Ethereum — разные активы с одним тикером. */
  network?: "ton";
  /** У валюты площадки — площадка: курса на рынке у неё нет, он задаётся руками. */
  platform?: "telegram" | "vk";
}

/**
 * Опорная валюта: курс любой валюты — цена одной её единицы в долларах.
 * Кросс-курсы считаются через неё, и её собственный курс всегда единица.
 */
export const REFERENCE_CURRENCY: CurrencyCode = "USD";

export const CURRENCIES: readonly Currency[] = [
  { code: "USD", kind: "fiat", decimals: 2, nameKey: "currency.usd", formerCodes: [] },
  { code: "EUR", kind: "fiat", decimals: 2, nameKey: "currency.eur", formerCodes: [] },
  { code: "RUB", kind: "fiat", decimals: 2, nameKey: "currency.rub", formerCodes: ["RUR"] },
  { code: "XTR", kind: "platform", decimals: 0, nameKey: "currency.xtr", formerCodes: [], platform: "telegram" },
  { code: "GRAM", kind: "crypto", decimals: 9, nameKey: "currency.gram", formerCodes: ["TON"], network: "ton" },
  { code: "USDT", kind: "crypto", decimals: 6, nameKey: "currency.usdt", formerCodes: [], network: "ton" },
];

const BY_CODE: ReadonlyMap<string, Currency> = new Map(CURRENCIES.map((entry) => [entry.code, entry]));

export function isCurrencyCode(value: string): value is CurrencyCode {
  return BY_CODE.has(value);
}

export function currency(code: CurrencyCode): Currency {
  const found = BY_CODE.get(code);
  if (!found) throw new Error(`неизвестная валюта: ${code}`);
  return found;
}

/** Код по нынешнему или прежнему имени: «TON» → GRAM. Неизвестное — null, не ошибка. */
export function resolveCurrencyCode(codeOrFormer: string): CurrencyCode | null {
  if (isCurrencyCode(codeOrFormer)) return codeOrFormer;
  const former = CURRENCIES.find((entry) => entry.formerCodes.includes(codeOrFormer));
  return former?.code ?? null;
}

/** Сумма в минорных единицах — в обычную запись валюты. */
export function fromMinorUnits(minor: bigint, code: CurrencyCode): Decimal {
  return Decimal.fromMinor(minor, currency(code).decimals);
}

/**
 * Проверка реестра — для теста, чтобы ошибка называла валюту и поле, а не
 * всплывала в пересчёте цены.
 */
export function findCurrencyProblems(list: readonly Currency[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    if (seen.has(entry.code)) problems.push(`валюта ${entry.code}: код повторяется`);
    seen.add(entry.code);
    if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 18) {
      problems.push(`валюта ${entry.code}: разрядность ${entry.decimals} вне 0..18`);
    }
    if (!entry.nameKey) problems.push(`валюта ${entry.code}: нет ключа имени`);
    if (entry.kind === "platform" && !entry.platform) problems.push(`валюта ${entry.code}: валюта площадки без площадки`);
    if (entry.kind !== "platform" && entry.platform) problems.push(`валюта ${entry.code}: площадка указана у валюты не площадки`);
    if (entry.kind === "crypto" && !entry.network) problems.push(`валюта ${entry.code}: у крипты не указана сеть`);
    for (const former of entry.formerCodes) {
      if (list.some((other) => other.code === former)) problems.push(`валюта ${entry.code}: прежний код ${former} занят действующей валютой`);
    }
  }

  const reference = list.find((entry) => entry.code === REFERENCE_CURRENCY);
  if (!reference) problems.push(`опорной валюты ${REFERENCE_CURRENCY} нет в реестре`);
  else if (reference.kind !== "fiat") problems.push(`опорная валюта ${REFERENCE_CURRENCY} должна быть фиатом`);

  return problems;
}
