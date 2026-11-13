/**
 * Валюта в ядре учёта: код и число знаков после запятой. Справочник валют
 * ядро не знает — его передаёт вызывающий (docs/37-accounting.md, §2), поэтому
 * ядро переносится в другой проект без правки.
 */
export interface CurrencySpec {
  code: string;
  /** сколько знаков в минимальной единице: звёзды — 0, рубль — 2, Gram — 9 */
  decimals: number;
}

const MAX_DECIMALS = 18;

// Минус — и ASCII, и типографский: сумму могут вставить из текста отчёта.
const DECIMAL_RE = /^([+\-−])?(\d*)(?:\.(\d+))?$/u;

function assertDecimals(spec: CurrencySpec): void {
  if (!Number.isInteger(spec.decimals) || spec.decimals < 0 || spec.decimals > MAX_DECIMALS) {
    throw new RangeError(`Валюта ${spec.code}: число знаков должно быть целым от 0 до ${MAX_DECIMALS}, получено ${spec.decimals}`);
  }
}

/**
 * Десятичная строка в минимальные единицы валюты. Лишних знаков ядро не
 * округляет: потерянная копейка в учёте хуже исключения; допускаются только
 * нули сверх знаков валюты («1.500» при двух знаках).
 */
export function toMinor(value: string, spec: CurrencySpec): bigint {
  assertDecimals(spec);
  const match = DECIMAL_RE.exec(value);
  const intPart = match?.[2] ?? "";
  const fracPart = match?.[3] ?? "";
  if (match === null || (intPart === "" && fracPart === "")) {
    throw new SyntaxError(`Сумма «${value}» не десятичное число`);
  }
  const extra = fracPart.slice(spec.decimals);
  if (/[^0]/u.test(extra)) {
    throw new RangeError(`Сумма «${value}» длиннее ${spec.decimals} знаков валюты ${spec.code}: округлять нечем`);
  }
  const digits = (intPart === "" ? "0" : intPart) + fracPart.slice(0, spec.decimals).padEnd(spec.decimals, "0");
  const amount = BigInt(digits);
  return match[1] === "-" || match[1] === "−" ? -amount : amount;
}

/** Минимальные единицы обратно в десятичную строку, без потери точности. */
export function formatMinor(amount: bigint, spec: CurrencySpec): string {
  assertDecimals(spec);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(spec.decimals + 1, "0");
  const intPart = digits.slice(0, digits.length - spec.decimals);
  const fracPart = digits.slice(digits.length - spec.decimals);
  const text = spec.decimals === 0 ? intPart : `${intPart}.${fracPart}`;
  return negative ? `-${text}` : text;
}
