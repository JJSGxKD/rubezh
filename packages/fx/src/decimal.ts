import { Decimal as DecimalBase } from "decimal.js";

/**
 * Десятичная арифметика курсов. `number` здесь запрещён: у источника
 * (`vpnsibcom_api`, `fx.util.ts`) курс хранился `Float` и округлялся
 * `toFixed(15)` на каждом шаге — ошибка копилась в пересчёте цен и выручки.
 *
 * Свой экземпляр, а не глобальная настройка `Decimal.set`: глобальная точность
 * — общее состояние процесса, и любой соседний модуль мог бы её сменить.
 * Сорок значащих цифр — с запасом: курс звезды в долларах — сотые доли
 * цента, а цена в Gram — девять знаков после запятой.
 */
export const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });

export type Decimal = InstanceType<typeof Decimal>;

export type DecimalInput = Decimal | string | number;

export type Rounding = DecimalBase.Rounding;

/**
 * Число с границы — строка или JSON-число источника. У JSON-числа берётся
 * его кратчайшая запись (`String(0.1)` — это `"0.1"`), а не двоичное
 * значение: иначе `0.1` превратилось бы в `0.1000000000000000055…`.
 */
export function decimal(value: DecimalInput): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError(`не число: ${value}`);
  const parsed = new Decimal(typeof value === "number" ? String(value) : value.trim());
  if (!parsed.isFinite()) throw new RangeError(`не число: ${String(value)}`);
  return parsed;
}

/** Строго больше нуля — курс, цена за единицу, номинал. */
export function positive(value: DecimalInput, what: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = decimal(value);
  } catch {
    throw new RangeError(`${what}: не число — ${String(value)}`);
  }
  if (!parsed.isPositive() || parsed.isZero()) throw new RangeError(`${what}: должно быть больше нуля — ${parsed.toString()}`);
  return parsed;
}
