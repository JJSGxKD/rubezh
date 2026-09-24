import { isGranted, type StoredPurchase } from "../../src/modules/payments/purchase-types.js";
import type { InvoiceOutcome, InvoiceRecord, PurchasesRepository } from "../../src/modules/payments/purchases.repository.js";

/**
 * Покупки в памяти — для тестов сервиса. Смысл тот же, что у реализации на
 * Postgres: одна строка на продолжение забега, цена меняется только у
 * неоплаченной. Сама реализация проверяется на живой базе.
 */
export class MemoryPurchasesRepository implements PurchasesRepository {
  readonly rows = new Map<string, StoredPurchase>();

  async openInvoice(record: InvoiceRecord): Promise<InvoiceOutcome> {
    const existing = [...this.rows.values()].find((row) => row.runId === record.runId && row.continueNo === record.continueNo);
    if (existing !== undefined) {
      if (existing.accountId !== record.accountId) return { kind: "foreign" };
      if (isGranted(existing)) return { kind: "paid", purchase: { ...existing } };
      Object.assign(existing, {
        elapsedSec: record.elapsedSec,
        priceStars: record.priceStars,
        chargedStars: record.chargedStars,
        mode: record.mode,
        invoicedAt: record.invoicedAt,
      });
      return { kind: "opened", purchase: { ...existing } };
    }
    const created: StoredPurchase = {
      purchaseId: record.purchaseId,
      accountId: record.accountId,
      runId: record.runId,
      continueNo: record.continueNo,
      elapsedSec: record.elapsedSec,
      priceStars: record.priceStars,
      chargedStars: record.chargedStars,
      mode: record.mode,
      status: "pending",
      telegramChargeId: null,
      invoicedAt: record.invoicedAt,
      paidAt: null,
      refundReason: null,
      refundRequestedAt: null,
      refundedAt: null,
    };
    this.rows.set(created.purchaseId, created);
    return { kind: "opened", purchase: { ...created } };
  }

  async byId(purchaseId: string): Promise<StoredPurchase | null> {
    const row = this.rows.get(purchaseId);
    return row === undefined ? null : { ...row };
  }

  async grantedContinues(runId: string): Promise<number> {
    return [...this.rows.values()].filter((row) => row.runId === runId && isGranted(row)).length;
  }
}
