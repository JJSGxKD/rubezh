import { currency, type CurrencyCode } from "../currency.js";
import { Decimal } from "../decimal.js";
import { RATE_SCALE } from "../rates/rate.js";
import { quoteOf, revenueInUsd, type RateSnapshot } from "../rates/snapshot.js";
import type { PaymentMethod } from "./payment-method.js";

/**
 * Выручка платежа (docs/35-stage4-plan.md §3.12): сумма в валюте оплаты,
 * снимок, пересчёт в валюту отчётности на момент оплаты, доля площадки и
 * комиссия провайдера — всё, что нужно бухгалтерии этапа 5
 * (docs/11-revenue-split.md). Считается по снимку платежа, поэтому
 * воспроизводится задним числом.
 */
export interface PaymentRecord {
  amount: Decimal;
  currency: CurrencyCode;
  methodId: string;
  snapshotId: string;
}

export interface Settlement {
  snapshotId: string;
  currency: CurrencyCode;
  gross: Decimal;
  providerFee: Decimal;
  platformShare: Decimal;
  /** Что остаётся нам — в валюте оплаты. */
  net: Decimal;
  reportingCurrency: CurrencyCode;
  grossReporting: Decimal;
  netReporting: Decimal;
}

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

/** Доллары — в валюту отчётности по курсу цены снимка, с округлением до её разрядности. Банковское округление: суммы складываются в отчёт, и половинки не должны сдвигать итог в одну сторону. */
function usdToReporting(usd: Decimal, reporting: CurrencyCode, snapshot: RateSnapshot): Decimal {
  return usd.div(quoteOf(snapshot, reporting).usdPerUnit, RATE_SCALE).round(currency(reporting).decimals, "half_even");
}

export function settle(payment: PaymentRecord, method: PaymentMethod, snapshot: RateSnapshot, reporting: CurrencyCode): Settlement {
  if (payment.methodId !== method.id) throw new SettlementError(`платёж способом ${payment.methodId}, а передан ${method.id}`);
  if (payment.currency !== method.currency) throw new SettlementError(`платёж в ${payment.currency}, а способ ${method.id} принимает ${method.currency}`);
  if (payment.snapshotId !== snapshot.id) throw new SettlementError(`платёж ссылается на снимок ${payment.snapshotId}, а передан ${snapshot.id}`);
  if (!payment.amount.isPositive()) throw new SettlementError("сумма платежа должна быть больше нуля");

  const decimals = currency(payment.currency).decimals;
  const gross = payment.amount;
  // Комиссия внутри: провайдер удерживает долю суммы. Сверху: игрок заплатил
  // цену плюс комиссию, и наша часть — цена, то есть gross / (1 + ставка).
  const providerFee = (method.fee.mode === "inside" ? gross.mul(method.fee.rate) : gross.sub(gross.div(Decimal.ONE.add(method.fee.rate), RATE_SCALE))).round(decimals, "half_even");
  const afterFee = gross.sub(providerFee);
  const platformShare = afterFee.mul(method.platformShare).round(decimals, "half_even");
  const net = afterFee.sub(platformShare);

  return {
    snapshotId: snapshot.id,
    currency: payment.currency,
    gross,
    providerFee,
    platformShare,
    net,
    reportingCurrency: reporting,
    grossReporting: usdToReporting(revenueInUsd(gross, payment.currency, snapshot), reporting, snapshot),
    netReporting: usdToReporting(revenueInUsd(net, payment.currency, snapshot), reporting, snapshot),
  };
}
