import type { CurrencyCode } from "../currencies.js";
import { Decimal, positive, type DecimalInput } from "../decimal.js";
import { convert, payoutUsdPerUnit, usdPerUnit, type RatesSnapshot } from "../rates.js";
import type { PaymentMethod } from "./price.js";

/**
 * Выручка платежа (docs/35-stage4-plan.md, §3.12): сумма в валюте оплаты,
 * снимок, пересчёт в валюту отчётности на момент оплаты — всё, что нужно
 * бухгалтерии этапа 5 (docs/11-revenue-split.md).
 *
 * Два числа, и путать их нельзя:
 * - **оборот** — сколько заплатил игрок, по цене для игрока;
 * - **выручка** — сколько получим мы: у валют площадок — по курсу выплаты
 *   (у звёзд он ниже цены покупки на долю площадки), у остальных — за
 *   вычетом комиссии провайдера, если она удерживается из суммы.
 *
 * Пересчёт идёт по снимку платежа, а не по текущему курсу: отчёт за прошлый
 * месяц не должен меняться оттого, что сегодня подорожал Gram.
 */

export interface Revenue {
  snapshotId: string;
  currency: CurrencyCode;
  /** сколько заплатил игрок, в валюте оплаты */
  paid: Decimal;
  /** в валюте отчётности */
  turnover: Decimal;
  revenue: Decimal;
  reportCurrency: CurrencyCode;
}

export function revenueOf(input: { amount: DecimalInput; method: PaymentMethod; snapshot: RatesSnapshot; reportCurrency: CurrencyCode }): Revenue {
  const { method, snapshot } = input;
  const paid = positive(input.amount, `сумма платежа ${method.id}`);
  const feeKept = method.fee.placement === "inside" ? new Decimal(1).minus(method.fee.percent) : new Decimal(1);
  if (feeKept.isNegative()) throw new RangeError(`комиссия ${method.id} больше ста процентов`);

  const turnoverUsd = paid.mul(usdPerUnit(snapshot, method.currency));
  const revenueUsd = paid.mul(payoutUsdPerUnit(snapshot, method.currency)).mul(feeKept);
  return {
    snapshotId: snapshot.id,
    currency: method.currency,
    paid,
    turnover: convert(turnoverUsd, "USD", input.reportCurrency, snapshot),
    revenue: convert(revenueUsd, "USD", input.reportCurrency, snapshot),
    reportCurrency: input.reportCurrency,
  };
}
