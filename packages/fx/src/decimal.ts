/**
 * Десятичное число без потери точности: мантисса `bigint` и число знаков
 * после запятой. Курсы, цены и выручка считаются только на нём
 * (docs/35-stage4-plan.md §3.12): `number` теряет копейки уже на сложении
 * 0.1 + 0.2, а `Float` в базе источника переноса именно так и подвёл.
 *
 * Своя реализация, а не decimal.js: нужны четыре действия, сравнение и
 * округление с явным режимом — этого хватает, а зависимость на 30 КБ ради
 * того же тащила бы за собой ещё одно соглашение об округлении. Всё, что
 * здесь есть, покрыто тестами на границах (packages/fx/test/decimal.test.ts).
 *
 * Значение всегда нормализовано: хвостовые нули дроби убраны, ноль — со
 * шкалой 0. Поэтому `1.50` и `1.5` равны и печатаются одинаково.
 */

export type RoundingMode = "half_up" | "half_even" | "down" | "up" | "ceil" | "floor";

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalError";
  }
}

const DECIMAL_TEXT = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Потолок экспоненты: `1e400` — не курс и не цена, а ошибка источника. */
const MAX_EXPONENT = 100;

const POW10_CACHE: bigint[] = [1n];

function pow10(exponent: number): bigint {
  if (exponent < 0 || !Number.isInteger(exponent)) throw new DecimalError(`степень десяти должна быть целой и неотрицательной: ${exponent}`);
  while (POW10_CACHE.length <= exponent) POW10_CACHE.push(POW10_CACHE[POW10_CACHE.length - 1]! * 10n);
  return POW10_CACHE[exponent]!;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Целочисленное деление с округлением по режиму. Единственное место, где
 * округление вообще происходит: и `div`, и `round` сводятся к нему.
 */
function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = abs(numerator);
  const d = abs(denominator);
  let quotient = n / d;
  const remainder = n % d;

  if (remainder !== 0n) {
    const twice = remainder * 2n;
    const bump = (() => {
      switch (mode) {
        case "down":
          return false;
        case "up":
          return true;
        case "ceil":
          return !negative;
        case "floor":
          return negative;
        case "half_up":
          return twice >= d;
        case "half_even":
          return twice > d || (twice === d && quotient % 2n === 1n);
      }
    })();
    if (bump) quotient += 1n;
  }
  return negative ? -quotient : quotient;
}

export type DecimalInput = Decimal | string | number | bigint;

export class Decimal {
  private constructor(
    /** мантисса со знаком */
    readonly unscaled: bigint,
    /** знаков после запятой, всегда ≥ 0 */
    readonly scale: number,
  ) {}

  static readonly ZERO = new Decimal(0n, 0);
  static readonly ONE = new Decimal(1n, 0);

  /**
   * Из строки, числа, bigint или другого Decimal. Число принимается ради
   * ответов источников в JSON, где оно уже число; `NaN` и бесконечность —
   * ошибка, а не ноль.
   */
  static of(value: DecimalInput): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === "bigint") return new Decimal(value, 0);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new DecimalError(`не число: ${value}`);
      // toString даёт кратчайшую запись, которая читается обратно в то же
      // число, — в том числе с экспонентой у очень малых значений.
      return Decimal.parse(value.toString());
    }
    return Decimal.parse(value);
  }

  /** Строгий разбор: «1», «-0.5», «1.5e-7». Запятая, пробелы внутри, пустота — ошибка. */
  static parse(text: string): Decimal {
    const match = DECIMAL_TEXT.exec(text.trim());
    if (!match) throw new DecimalError(`не десятичное число: "${text}"`);
    const [, sign, integerPart, fractionPart = "", exponentText = "0"] = match;
    const exponent = Number(exponentText);
    if (Math.abs(exponent) > MAX_EXPONENT) throw new DecimalError(`экспонента вне допустимого: "${text}"`);
    const unscaled = BigInt(integerPart! + fractionPart);
    return Decimal.normalized(sign === "-" ? -unscaled : unscaled, fractionPart.length - exponent);
  }

  /** Из минорных единиц валюты: 12345 копеек при разрядности 2 — 123.45. */
  static fromMinor(minor: bigint, decimals: number): Decimal {
    return Decimal.normalized(minor, decimals);
  }

  private static normalized(unscaled: bigint, scale: number): Decimal {
    if (scale < 0) {
      unscaled *= pow10(-scale);
      scale = 0;
    }
    while (scale > 0 && unscaled % 10n === 0n) {
      unscaled /= 10n;
      scale -= 1;
    }
    return unscaled === 0n ? Decimal.ZERO : new Decimal(unscaled, scale);
  }

  private static aligned(a: Decimal, b: Decimal): [bigint, bigint, number] {
    const scale = Math.max(a.scale, b.scale);
    return [a.unscaled * pow10(scale - a.scale), b.unscaled * pow10(scale - b.scale), scale];
  }

  add(other: DecimalInput): Decimal {
    const [x, y, scale] = Decimal.aligned(this, Decimal.of(other));
    return Decimal.normalized(x + y, scale);
  }

  sub(other: DecimalInput): Decimal {
    const [x, y, scale] = Decimal.aligned(this, Decimal.of(other));
    return Decimal.normalized(x - y, scale);
  }

  /** Умножение точное: шкалы складываются, ничего не округляется. */
  mul(other: DecimalInput): Decimal {
    const o = Decimal.of(other);
    return Decimal.normalized(this.unscaled * o.unscaled, this.scale + o.scale);
  }

  /**
   * Деление — единственное действие, где точность конечна, поэтому число
   * знаков результата задаётся явно, как и режим округления.
   */
  div(other: DecimalInput, places: number, mode: RoundingMode = "half_up"): Decimal {
    const o = Decimal.of(other);
    if (o.isZero()) throw new DecimalError("деление на ноль");
    if (places < 0 || !Number.isInteger(places)) throw new DecimalError(`число знаков должно быть целым и неотрицательным: ${places}`);
    const numerator = this.unscaled * pow10(places + o.scale);
    const denominator = o.unscaled * pow10(this.scale);
    return Decimal.normalized(divRound(numerator, denominator, mode), places);
  }

  /** Сдвиг на степень десяти — точный, в обе стороны. */
  shift(exponent: number): Decimal {
    return Decimal.normalized(this.unscaled, this.scale - exponent);
  }

  round(places: number, mode: RoundingMode = "half_up"): Decimal {
    if (places < 0 || !Number.isInteger(places)) throw new DecimalError(`число знаков должно быть целым и неотрицательным: ${places}`);
    if (this.scale <= places) return this;
    return Decimal.normalized(divRound(this.unscaled, pow10(this.scale - places), mode), places);
  }

  neg(): Decimal {
    return Decimal.normalized(-this.unscaled, this.scale);
  }

  abs(): Decimal {
    return this.isNegative() ? this.neg() : this;
  }

  cmp(other: DecimalInput): -1 | 0 | 1 {
    const [x, y] = Decimal.aligned(this, Decimal.of(other));
    return x < y ? -1 : x > y ? 1 : 0;
  }

  eq(other: DecimalInput): boolean {
    return this.cmp(other) === 0;
  }

  lt(other: DecimalInput): boolean {
    return this.cmp(other) < 0;
  }

  lte(other: DecimalInput): boolean {
    return this.cmp(other) <= 0;
  }

  gt(other: DecimalInput): boolean {
    return this.cmp(other) > 0;
  }

  gte(other: DecimalInput): boolean {
    return this.cmp(other) >= 0;
  }

  isZero(): boolean {
    return this.unscaled === 0n;
  }

  isNegative(): boolean {
    return this.unscaled < 0n;
  }

  isPositive(): boolean {
    return this.unscaled > 0n;
  }

  static min(first: Decimal, ...rest: Decimal[]): Decimal {
    return rest.reduce((acc, value) => (value.lt(acc) ? value : acc), first);
  }

  static max(first: Decimal, ...rest: Decimal[]): Decimal {
    return rest.reduce((acc, value) => (value.gt(acc) ? value : acc), first);
  }

  /** Минорные единицы валюты: 123.456 при разрядности 2 — 12346 (half_up). */
  toMinor(decimals: number, mode: RoundingMode = "half_up"): bigint {
    return this.round(decimals, mode).shift(decimals).unscaled;
  }

  /** Обычная запись без экспоненты: «-0.001», «1200», «3.5». */
  toString(): string {
    const digits = abs(this.unscaled).toString().padStart(this.scale + 1, "0");
    const integerPart = digits.slice(0, digits.length - this.scale);
    const fractionPart = digits.slice(digits.length - this.scale);
    const sign = this.isNegative() ? "-" : "";
    return fractionPart ? `${sign}${integerPart}.${fractionPart}` : `${sign}${integerPart}`;
  }

  /** Ровно `places` знаков после запятой — для показа сумм: «5.00», «0.50». */
  toFixed(places: number, mode: RoundingMode = "half_up"): string {
    const rounded = this.round(places, mode);
    const text = rounded.toString();
    if (places === 0) return text;
    const [integerPart, fractionPart = ""] = text.split(".");
    return `${integerPart}.${fractionPart.padEnd(places, "0")}`;
  }

  /** Только для показа и метрик: обратно в Decimal такое число не возвращают. */
  toNumber(): number {
    return Number(this.toString());
  }

  toJSON(): string {
    return this.toString();
  }
}
