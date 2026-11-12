/**
 * Покупка — в тех же значениях, что перечисления схемы БД
 * (`prisma/schema.prisma`, `Purchase`). Отдельно от сгенерированного клиента:
 * сервису и тестам незачем знать о Prisma.
 */

export const PAYMENT_MODES = ["live", "test"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export type PurchaseStatus = "pending" | "paid" | "refunded";
export type RefundReason = "test_mode" | "unused" | "external" | "undeliverable" | "manual";
/**
 * Что продаётся: второй шанс в забеге, товар каталога магазина, VIP (WP10) или
 * донат проекту (Р109) — добровольная сумма без игровых ценностей.
 */
export const PURCHASE_PRODUCTS = ["continue_run", "shop_item", "vip", "donation"] as const;
export type PurchaseProduct = (typeof PURCHASE_PRODUCTS)[number];

/** Донат — поддержка, а не покупка (Р109): отчёты, цели сетей и разрезы считают покупки как `product <> DONATION_PRODUCT`. */
export const DONATION_PRODUCT = "donation" satisfies PurchaseProduct;

/**
 * Подписка площадки (Р20): площадка списывает каждый период сама, по тому же
 * счёту. Каждое списание — своя строка покупки со ссылкой на первую.
 */
export const SUBSCRIPTION_PRODUCTS: readonly PurchaseProduct[] = ["vip"];

/** Что команда может сделать с покупкой: вернуть звёзды, повторить выдачу, повторить учёт (Р209), компенсировать (Р209). */
export type PurchaseAction = "refund" | "fulfill" | "retry" | "compensate";

/**
 * Состояния фильтра ленты платежей в панели (Р209, WP53). Условия каждого — в
 * `payments-feed.repository.ts`; значения идут в запрос и в панель как есть.
 */
export const FEED_STATUSES = ["pending", "paid", "undelivered", "refund_requested", "refunded"] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];

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
