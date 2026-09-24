/**
 * Покупка — в тех же значениях, что перечисления схемы БД
 * (`prisma/schema.prisma`, `Purchase`). Отдельно от сгенерированного клиента:
 * сервису и тестам незачем знать о Prisma.
 */

export type PaymentMode = "live" | "test";
export type PurchaseStatus = "pending" | "paid" | "refunded";
export type RefundReason = "test_mode" | "unused" | "external";

export interface StoredPurchase {
  purchaseId: string;
  accountId: string;
  runId: string;
  continueNo: number;
  elapsedSec: number;
  priceStars: number;
  chargedStars: number;
  mode: PaymentMode;
  status: PurchaseStatus;
  telegramChargeId: string | null;
  invoicedAt: Date;
  paidAt: Date | null;
  refundReason: RefundReason | null;
  refundRequestedAt: Date | null;
  refundedAt: Date | null;
}

/**
 * Платить и получать возврат может только настоящий Telegram ID — цифры. У
 * входа разработчика `dev-…`: звёзд у него нет.
 */
export function isTelegramUserId(platformUserId: string): boolean {
  return /^\d{1,20}$/.test(platformUserId);
}

/**
 * Продолжение выдано — если оплата была. Возврат его не отзывает: к моменту
 * возврата продолжение обычно давно потрачено (docs/34-stage3-plan.md, WP5,
 * п. 8).
 */
export function isGranted(purchase: Pick<StoredPurchase, "paidAt">): boolean {
  return purchase.paidAt !== null;
}
