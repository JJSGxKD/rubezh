/**
 * Деньги формы операции (tasks/T-0464): десятичные строки в минимальные единицы валюты и обратно без плавающей
 * точки. Число знаков — копия справочника ядра курсов (`packages/fx`): пакетов между панелью и бэкендом нет.
 * Это только предпросмотр: проводку и проверку сумм делает сервер.
 */
export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = { USD: 2, EUR: 2, RUB: 2, GRAM: 9, USDT: 6, XTR: 0 };

/** Предел суммы — тот же, что у сервера: половина диапазона `bigint` базы. */
const MAX_MINOR = (1n << 62n) - 1n;

/** «52.3» + `GRAM` → 52 300 000 000; лишние знаки, знак, экспонента, пустота и чужая валюта — `null`. Запятая как точка. */
export function toMinor(raw: string, currency: string): bigint | null {
  const decimals = CURRENCY_DECIMALS[currency];
  if (decimals === undefined) return null;
  const match = /^(\d{1,18})(?:[.,](\d{1,18}))?$/u.exec(raw.trim());
  if (match === null) return null;
  const [, integer = "", fraction = ""] = match;
  if (fraction.length > decimals) return null;
  const value = BigInt(integer + fraction.padEnd(decimals, "0"));
  return value > MAX_MINOR ? null : value;
}

/** Обратно: с полным числом знаков валюты, минус у отрицательных. */
export function fromMinor(minor: bigint, currency: string): string {
  const decimals = CURRENCY_DECIMALS[currency] ?? 0;
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(decimals + 1, "0");
  const integer = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${integer}${decimals === 0 ? "" : `.${fraction}`}`;
}
