import { isGranted, type RefundReason, type StoredPurchase } from "../../src/modules/payments/purchase-types.js";
import type {
  CheckoutView,
  ConfirmOutcome,
  InvoiceOutcome,
  InvoiceRecord,
  PaymentRecord,
  PurchasesRepository,
  RefundedRecord,
  RefundOrder,
} from "../../src/modules/payments/purchases.repository.js";

/**
 * Покупки в памяти — для тестов сервиса. Смысл тот же, что у реализации на
 * Postgres: одна строка на продолжение забега, цена меняется только у
 * неоплаченной. Сама реализация проверяется на живой базе.
 */
export class MemoryPurchasesRepository implements PurchasesRepository {
  readonly rows = new Map<string, StoredPurchase>();
  /** Telegram ID владельцев — то, что в базе лежит в `account` */
  readonly owners = new Map<string, string>();
  /** законченные забеги — то, что в базе лежит в `run` */
  readonly finishedRuns = new Set<string>();

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

  async byAccount(accountId: string, limit: number): Promise<StoredPurchase[]> {
    return [...this.rows.values()]
      .filter((row) => row.accountId === accountId)
      .sort((a, b) => b.invoicedAt.getTime() - a.invoicedAt.getTime())
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async byId(purchaseId: string): Promise<StoredPurchase | null> {
    const row = this.rows.get(purchaseId);
    return row === undefined ? null : { ...row };
  }

  async grantedContinues(runId: string): Promise<number> {
    return [...this.rows.values()].filter((row) => row.runId === runId && isGranted(row)).length;
  }

  async grantedForRun(runId: string): Promise<{ continueNo: number; elapsedSec: number }[]> {
    return [...this.rows.values()]
      .filter((row) => row.runId === runId && isGranted(row))
      .sort((a, b) => a.continueNo - b.continueNo)
      .map(({ continueNo, elapsedSec }) => ({ continueNo, elapsedSec }));
  }

  async checkout(purchaseId: string): Promise<CheckoutView | null> {
    const row = this.rows.get(purchaseId);
    if (row === undefined) return null;
    return { purchase: { ...row }, platformUserId: this.owners.get(row.accountId) ?? "", runFinished: this.finishedRuns.has(row.runId) };
  }

  async markPaid(record: PaymentRecord): Promise<ConfirmOutcome> {
    const known = [...this.rows.values()].find((row) => row.telegramChargeId === record.chargeId);
    if (known !== undefined) return { kind: "duplicate", purchase: { ...known } };
    const row = this.rows.get(record.purchaseId);
    if (row === undefined) return { kind: "unknown" };
    if (row.status !== "pending") return { kind: "already_paid", purchase: { ...row } };
    Object.assign(row, { status: "paid", paidAt: record.paidAt, telegramChargeId: record.chargeId, chargedStars: record.chargedStars });
    return { kind: "paid", purchase: { ...row }, runFinished: this.finishedRuns.has(row.runId) };
  }

  async markRefunded(chargeId: string, refundedAt: Date): Promise<RefundedRecord | null> {
    const row = [...this.rows.values()].find((item) => item.telegramChargeId === chargeId);
    if (row === undefined) return null;
    const firstTime = row.refundedAt === null;
    if (firstTime) Object.assign(row, { status: "refunded", refundedAt });
    row.refundReason ??= "external";
    return { purchase: { ...row }, firstTime };
  }

  async refundStats(accountId: string): Promise<{ paid: number; refunded: number }> {
    const live = [...this.rows.values()].filter((row) => row.accountId === accountId && row.mode === "live");
    return { paid: live.filter(isGranted).length, refunded: live.filter((row) => row.refundReason === "external").length };
  }

  async requestRefund(purchaseId: string, reason: RefundReason, at: Date): Promise<RefundOrder | null> {
    const row = this.rows.get(purchaseId);
    if (row === undefined || !isGranted(row) || row.refundedAt !== null) return null;
    if (row.refundRequestedAt === null) Object.assign(row, { refundReason: reason, refundRequestedAt: at });
    return this.orderOf(row);
  }

  async pendingRefunds(limit: number): Promise<RefundOrder[]> {
    return [...this.rows.values()]
      .map((row) => this.orderOf(row))
      .filter((order) => order !== null)
      .slice(0, limit);
  }

  async unusedGrants(runId: string, usedContinues: number): Promise<string[]> {
    return [...this.rows.values()]
      .filter((row) => row.runId === runId && isGranted(row) && row.continueNo > usedContinues && row.refundRequestedAt === null)
      .map((row) => row.purchaseId);
  }

  private orderOf(row: StoredPurchase): RefundOrder | null {
    const owner = this.owners.get(row.accountId) ?? "";
    if (row.telegramChargeId === null || row.refundRequestedAt === null || row.refundedAt !== null || row.refundReason === null) return null;
    return { purchaseId: row.purchaseId, platform: "telegram", chargeId: row.telegramChargeId, payerId: owner, reason: row.refundReason };
  }
}
