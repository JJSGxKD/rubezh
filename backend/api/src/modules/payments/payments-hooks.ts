import { Injectable, Logger } from "@nestjs/common";
import type { PaymentMode } from "./purchase-types.js";

/**
 * Оплата подтверждена — кому это интересно: воронке (первая покупка), потом
 * заданиям и бухгалтерии. Модуль оплаты о них не знает: слушатели
 * подписываются сами — тот же приём, что `RunsHooks`.
 *
 * Событие — только о **первом** подтверждении: повтор обновления от площадки
 * слушателей не зовёт.
 */
export interface PaidPurchase {
  purchaseId: string;
  accountId: string;
  /** тестовая оплата — не выручка: слушатели, которым нужны деньги, её пропускают */
  mode: PaymentMode;
  at: Date;
}

export type PaidListener = (purchase: PaidPurchase) => Promise<void>;

@Injectable()
export class PaymentsHooks {
  private readonly logger = new Logger("payments");
  private readonly listeners: { name: string; listener: PaidListener }[] = [];

  onPaid(name: string, listener: PaidListener): void {
    this.listeners.push({ name, listener });
  }

  /** После записи оплаты; упавший слушатель не отменяет ни её, ни остальных. */
  emitPaid(purchase: PaidPurchase): Promise<void> {
    return Promise.all(
      this.listeners.map(async ({ name, listener }) => {
        try {
          await listener(purchase);
        } catch (error: unknown) {
          this.logger.error(
            JSON.stringify({
              module: "payments",
              event: "listener_failed",
              listener: name,
              purchaseId: purchase.purchaseId,
              reason: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      }),
    ).then(() => undefined);
  }
}
