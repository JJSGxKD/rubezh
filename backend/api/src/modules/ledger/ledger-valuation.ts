import { BASE_CURRENCY, Decimal, currency, isCurrencyCode, type CurrencyCode, type RatesSnapshot } from "@bh/fx";
import type { AccountBalanceView } from "./ledger-view.js";

/**
 * Оценка остатков в долларах и рублях (docs/37-accounting.md, О45–О46, Р219, tasks/T-0459): чистые функции без
 * базы и Nest. Звёзды — по курсу выплаты (сколько получаем мы, а не платит игрок), остальные валюты — по
 * рыночному; курс текущий. Нет нужного курса — `null`: ноль вместо «неизвестно» соврал бы на весь остаток.
 */

/** Что нужно оценке от снимка курсов: рыночные и выплаты; идентификатор снимка не нужен. */
export type ValuationSnapshot = Pick<RatesSnapshot, "rates" | "payout">;

export interface Valuation {
  /** доллары, вниз до цента: «795.60» */
  usd: string;
  /** рубли, вниз до копейки: «73519.44» */
  rub: string;
}

/** Курс единицы валюты в долларах: доллар — единица, валюта площадки — по выплате, остальные — рыночный. */
function usdPerUnit(code: CurrencyCode, snapshot: ValuationSnapshot): Decimal | null {
  if (code === BASE_CURRENCY) return new Decimal(1);
  const source = currency(code).kind === "platform" ? snapshot.payout : snapshot.rates;
  return source.get(code)?.usdPerUnit ?? null;
}

/** Деньги вниз до двух знаков; «вниз» — к нулю, чтобы оценка не превышала остаток по модулю. */
function cents(value: Decimal): string {
  return value.toFixed(2, Decimal.ROUND_DOWN);
}

/** Сумма из строки; нечитаемая — `null`: повреждённые данные не должны ронять экран. */
function parseAmount(balance: string): Decimal | null {
  if (!/^-?\d+(\.\d+)?$/u.test(balance)) return null;
  return new Decimal(balance);
}

/**
 * Стоимость остатка в долларах и рублях. Рубль нужен для каждой оценки (пересчёт долларов в рубли), поэтому
 * без рыночного курса рубля `null` у всех валют.
 */
export function valueOf(balance: string, code: string, snapshot: ValuationSnapshot): Valuation | null {
  if (!isCurrencyCode(code)) return null;
  const amount = parseAmount(balance);
  if (amount === null) return null;

  const unit = usdPerUnit(code, snapshot);
  const rubUsd = snapshot.rates.get("RUB")?.usdPerUnit;
  if (unit === null || rubUsd === undefined) return null;

  const usd = amount.mul(unit);
  // у рубля — напрямую: круг «рубли → доллары → рубли» терял бы копейки
  const rub = code === "RUB" ? amount : usd.div(rubUsd);
  return { usd: cents(usd), rub: cents(rub) };
}

/**
 * Итог по активам: сумма оценок, уже округлённых по счетам (на экране итог равен сумме показанного). Хотя бы у
 * одного актива нет оценки или нет снимка — итога нет: неполная сумма выдавала бы себя за полную.
 */
export function totalAssets(accounts: readonly AccountBalanceView[], snapshot: ValuationSnapshot | null): Valuation | null {
  if (snapshot === null) return null;
  let usd = new Decimal(0);
  let rub = new Decimal(0);
  for (const account of accounts) {
    if (account.type !== "asset") continue;
    const value = valueOf(account.balance, account.currency, snapshot);
    if (value === null) return null;
    usd = usd.add(value.usd);
    rub = rub.add(value.rub);
  }
  return { usd: usd.toFixed(2), rub: rub.toFixed(2) };
}

