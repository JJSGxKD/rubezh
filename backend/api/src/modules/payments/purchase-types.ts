/**
 * Покупка — в тех же значениях, что перечисления схемы БД
 * (`prisma/schema.prisma`, `Purchase`). Отдельно от сгенерированного клиента:
 * сервису и тестам незачем знать о Prisma.
 */

export type PaymentMode = "live" | "test";
export type PurchaseStatus = "pending" | "paid" | "refunded";
export type RefundReason = "test_mode" | "unused" | "external" | "undeliverable";
/** Что продаётся: второй шанс в забеге, товар каталога магазина или VIP (WP10). */
export type PurchaseProduct = "continue_run" | "shop_item" | "vip";

/**
 * Подписка площадки (Р20): площадка списывает каждый период сама, по тому же
 * счёту. Каждое списание — своя строка покупки со ссылкой на первую.
 */
export const SUBSCRIPTION_PRODUCTS: readonly PurchaseProduct[] = ["vip"];

export interface StoredPurchase {
  purchaseId: string;
  accountId: string;
  product: PurchaseProduct;
  /** у второго шанса — всегда; у товара магазина — пусто */
  runId: string | null;
  continueNo: number | null;
  elapsedSec: number | null;
  /** у товара магазина — всегда; у второго шанса — пусто */
  sku: string | null;
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
  /** товар выдан хозяином товара; у второго шанса выдача — сама оплата */
  fulfilledAt: Date | null;
  /** продление подписки: первая покупка подписки; у первой и у разовых — пусто */
  renewalOf: string | null;
}

/**
 * Право выдано — если оплата была. Возврат его не отзывает: к моменту
 * возврата продолжение обычно давно потрачено (docs/34-stage3-plan.md, WP5,
 * п. 8), а товар магазина — лёг в кошелёк.
 */
export function isGranted(purchase: Pick<StoredPurchase, "paidAt">): boolean {
  return purchase.paidAt !== null;
}
