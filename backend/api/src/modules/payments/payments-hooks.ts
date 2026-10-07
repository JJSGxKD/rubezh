import { Injectable, Logger } from "@nestjs/common";
import type { PaymentMode, PurchaseProduct, StoredPurchase } from "./purchase-types.js";

/**
 * Что случилось с оплатой — кому это интересно: воронке (первая покупка),
 * хозяину подписки (продление отменено), потом заданиям и бухгалтерии.
 * Модуль оплаты о них не знает: слушатели подписываются сами — тот же приём,
 * что `RunsHooks`.
 *
 * Событие оплаты — только о **первом** подтверждении: повтор обновления от
 * площадки слушателей не зовёт.
 */
export interface PaidPurchase {
  purchaseId: string;
  accountId: string;
  /** тестовая оплата — не выручка: слушатели, которым нужны деньги, её пропускают */
  mode: PaymentMode;
  at: Date;
}

/** Продление подписки: `cancelled` — отменено на площадке, `active` — возвращено, `failed` — площадка не смогла списать. */
export type SubscriptionState = "active" | "cancelled" | "failed";

/** Площадка сообщила о продлении подписки: что с ним и какая это подписка. */
export interface SubscriptionChange {
  /** первая покупка подписки — по её счёту площадка и списывает периоды */
  subscription: StoredPurchase;
  state: SubscriptionState;
  at: Date;
}

/**
 * Оплаченная покупка, которую проход довыдачи не смог закрыть выдачей: товара
 * нет в каталоге (`reason: "undeliverable"`, звёзды возвращаются сами) или
 * выдача падает по другой причине (`reason` — её текст, нужен человек).
 */
export interface StuckPurchase {
  purchaseId: string;
  accountId: string;
  product: PurchaseProduct;
  sku: string | null;
  chargedStars: number;
  paidAt: Date;
  reason: string;
}

export type StuckListener = (purchase: StuckPurchase) => Promise<void>;

export type PaidListener = (purchase: PaidPurchase) => Promise<void>;
export type SubscriptionListener = (change: SubscriptionChange) => Promise<void>;

@Injectable()
export class PaymentsHooks {
  private readonly logger = new Logger("payments");
  private readonly paid: { name: string; listener: PaidListener }[] = [];
  private readonly subscriptions: { name: string; listener: SubscriptionListener }[] = [];
  private readonly stuck: { name: string; listener: StuckListener }[] = [];

  onPaid(name: string, listener: PaidListener): void {
    this.paid.push({ name, listener });
  }

  onSubscriptionChanged(name: string, listener: SubscriptionListener): void {
    this.subscriptions.push({ name, listener });
  }

  onStuck(name: string, listener: StuckListener): void {
    this.stuck.push({ name, listener });
  }

  /** После записи оплаты; упавший слушатель не отменяет ни её, ни остальных. */
  emitPaid(purchase: PaidPurchase): Promise<void> {
    return this.emit(this.paid, purchase, purchase.purchaseId);
  }

  /** Покупка зависла: проход довыдачи не смог её закрыть. Упавший слушатель не мешает остальным. */
  emitStuck(purchase: StuckPurchase): Promise<void> {
    return this.emit(this.stuck, purchase, purchase.purchaseId);
  }

  emitSubscriptionChanged(change: SubscriptionChange): Promise<void> {
    return this.emit(this.subscriptions, change, change.subscription.purchaseId);
  }

  private emit<T>(listeners: readonly { name: string; listener: (event: T) => Promise<void> }[], event: T, purchaseId: string): Promise<void> {
    return Promise.all(
      listeners.map(async ({ name, listener }) => {
        try {
          await listener(event);
        } catch (error: unknown) {
          this.logger.error(
            JSON.stringify({
              module: "payments",
              event: "listener_failed",
              listener: name,
              purchaseId,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      }),
    ).then(() => undefined);
  }
}
