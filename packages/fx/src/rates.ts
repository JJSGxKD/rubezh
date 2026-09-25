import { BASE_CURRENCY, currency, type CurrencyCode } from "./currencies.js";
import { Decimal, decimal, positive, type DecimalInput, type Rounding } from "./decimal.js";

/**
 * Курс — **в одном соглашении**: цена одной единицы валюты в опорной
 * (долларах). У источника (`vpnsibcom_api`) фиат хранил «сколько долларов
 * стоит единица», а крипта и звёзды — «сколько единиц за доллар», и
 * различались они типом валюты. Это однажды дало ошибку пересчёта, и
 * второй раз её не будет: другого соглашения в модуле нет, а привести
 * ответ источника к этому — забота его адаптера (`quote.ts`).
 */

export interface Rate {
  currency: CurrencyCode;
  /** цена одной единицы в долларах, строго больше нуля */
  usdPerUnit: Decimal;
  /** какие источники дали этот курс: один или несколько через медиану */
  sources: readonly string[];
  /** когда курс видели у источника — не когда его приняли */
  observedAt: Date;
}

/**
 * Снимок курсов — набор курсов на момент. Цена и платёж ссылаются на снимок,
 * по которому посчитаны, поэтому пересчёт выручки воспроизводится задним
 * числом (docs/11-revenue-split.md). Идентификатор даёт хранилище.
 */
export interface RatesSnapshot {
  id: string;
  takenAt: Date;
  /** цена единицы для покупателя — по нему считаются цены */
  rates: ReadonlyMap<CurrencyCode, Rate>;
  /**
   * сколько получаем мы за единицу при выводе — по нему считается выручка.
   * Только у валют площадок: у звёзд цена для игрока и выплата нам — разные
   * числа (`manual.ts`)
   */
  payout: ReadonlyMap<CurrencyCode, Rate>;
}

export class MissingRateError extends Error {
  constructor(readonly currency: CurrencyCode) {
    super(`нет курса ${currency}`);
    this.name = "MissingRateError";
  }
}

/** Цена единицы в долларах; у опорной валюты курс — единица по определению. */
export function usdPerUnit(snapshot: RatesSnapshot, code: CurrencyCode): Decimal {
  if (code === BASE_CURRENCY) return new Decimal(1);
  const rate = snapshot.rates.get(code);
  if (rate === undefined) throw new MissingRateError(code);
  return rate.usdPerUnit;
}

/**
 * Пересчёт суммы. Кросс-курс — через опорную валюту: `рубли → Gram` — это
 * рубли в доллары и доллары в Gram. Округления здесь нет: оно — решение того,
 * кто показывает или списывает сумму (`toMinorUnits`, слой цен).
 */
export function convert(amount: DecimalInput, from: CurrencyCode, to: CurrencyCode, snapshot: RatesSnapshot): Decimal {
  const value = decimal(amount);
  if (from === to) return value;
  return value.mul(usdPerUnit(snapshot, from)).div(usdPerUnit(snapshot, to));
}

/**
 * Сколько долларов мы получаем с одной единицы. У валюты площадки — только
 * курс выплаты: подставить вместо него цену для игрока значило бы завысить
 * выручку на комиссию площадки. У остальных выплата и цена — одно число.
 */
export function payoutUsdPerUnit(snapshot: RatesSnapshot, code: CurrencyCode): Decimal {
  if (currency(code).kind !== "platform") return usdPerUnit(snapshot, code);
  const rate = snapshot.payout.get(code);
  if (rate === undefined) throw new MissingRateError(code);
  return rate.usdPerUnit;
}

/** Курс «сколько `to` за одну `from`» — то, что показывают человеку. */
export function crossRate(from: CurrencyCode, to: CurrencyCode, snapshot: RatesSnapshot): Decimal {
  return convert(1, from, to, snapshot);
}

export type MinorRounding = "half_up" | "up" | "down";

const ROUNDING: Record<MinorRounding, Rounding> = {
  half_up: Decimal.ROUND_HALF_UP,
  up: Decimal.ROUND_UP,
  down: Decimal.ROUND_DOWN,
};

/**
 * Сумма в минорных единицах — целым, как её хранят и отправляют провайдеру:
 * копейки, нанограммы, звёзды. Направление округления — решение вызывающего:
 * цену для игрока округляют вверх, выплату — вниз.
 */
export function toMinorUnits(amount: DecimalInput, code: CurrencyCode, rounding: MinorRounding = "half_up"): bigint {
  const scaled = decimal(amount).mul(new Decimal(10).pow(currency(code).decimals));
  return BigInt(scaled.toDecimalPlaces(0, ROUNDING[rounding]).toFixed(0));
}

export function fromMinorUnits(minor: bigint, code: CurrencyCode): Decimal {
  return new Decimal(minor.toString()).div(new Decimal(10).pow(currency(code).decimals));
}

/** Курс из цены единицы в долларах — проверка «больше нуля» на входе, а не в пересчёте. */
export function rateOf(code: CurrencyCode, usd: DecimalInput, sources: readonly string[], observedAt: Date): Rate {
  return { currency: code, usdPerUnit: positive(usd, `курс ${code}`), sources, observedAt };
}
