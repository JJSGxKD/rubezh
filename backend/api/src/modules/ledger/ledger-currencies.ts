import { CURRENCIES, isCurrencyCode } from "@bh/fx";
import type { CurrencySpec } from "@bh/ledger";

/**
 * Валюта счёта для ядра учёта: код и число знаков из справочника ядра курсов. Ядро учёта справочника не знает
 * (docs/37-accounting.md §2), поэтому его передаёт бэкенд. Код вне справочника — повреждённая строка плана
 * счетов: показать сумму с угаданными знаками значило бы соврать на порядки, поэтому исключение.
 */
export function currencySpec(code: string): CurrencySpec {
  if (!isCurrencyCode(code)) {
    throw new Error(`Валюта «${code}» счёта учёта не входит в справочник валют`);
  }
  return { code, decimals: CURRENCIES[code].decimals };
}
