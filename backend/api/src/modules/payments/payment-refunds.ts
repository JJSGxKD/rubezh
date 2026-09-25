import { Inject, Injectable, Logger } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";
import { TelegramApiError, TELEGRAM_BOT_API, type TelegramBotApi } from "../../platforms/telegram/telegram-bot-api.js";
import type { ConfirmedPayment } from "./payment-confirmation.js";
import { PURCHASES_REPOSITORY, type ConfirmOutcome, type PurchasesRepository, type RefundOrder } from "./purchases.repository.js";

/**
 * Возвраты звёзд (docs/34-stage3-plan.md, WP5, п. 5.2 и 8): что вернуть и
 * как. Возвращаем сами в четырёх случаях:
 *
 * - **тестовая оплата** (Р14) — звезда возвращается сразу после
 *   подтверждения, продолжение засчитано;
 * - **продолжением не воспользовались** — забег закончился раньше, чем
 *   пришла оплата, или приложение закрыли, не продолжив: товар не выдан;
 * - **вторая оплата того же продолжения** — одно продолжение, одна оплата;
 * - **оплата без покупки** — продать было нечего.
 *
 * Сам возврат идёт через очередь (`payments-queue.ts`): упавший повторяется,
 * а не пропадает молча. Заказ возврата пишется в базу раньше обращения к
 * Telegram — после перезапуска очередь поднимет его оттуда.
 */

export type RefundBotApi = Pick<TelegramBotApi, "refundStarPayment">;

/** Telegram уже вернул эти звёзды: повтор возврата — не ошибка. */
const ALREADY_REFUNDED = /CHARGE_ALREADY_REFUNDED/i;

@Injectable()
export class PaymentRefunds {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: PurchasesRepository,
    @Inject(TELEGRAM_BOT_API) private readonly api: RefundBotApi,
  ) {}

  /** Что вернуть после подтверждения оплаты. */
  async afterConfirm(outcome: ConfirmOutcome, payment: ConfirmedPayment, nowMs = Date.now()): Promise<RefundOrder[]> {
    switch (outcome.kind) {
      case "paid": {
        const { purchase } = outcome;
        if (purchase.mode === "test") return await this.request(purchase.purchaseId, "test_mode", nowMs);
        if (outcome.runFinished) return await this.request(purchase.purchaseId, "unused", nowMs);
        return [];
      }
      case "already_paid":
        return [{ purchaseId: null, chargeId: payment.chargeId, userId: payment.userId, reason: "duplicate" }];
      case "unknown":
        return [{ purchaseId: null, chargeId: payment.chargeId, userId: payment.userId, reason: "unmatched" }];
      case "duplicate":
        return [];
    }
  }

  /**
   * Забег записан: оплаченные продолжения сверх взятых не использованы. Так
   * бывает, когда оплата подтвердилась, а приложение закрыли раньше, чем
   * игрок вернулся в забег, — забег ушёл смертью, а звёзды остались бы у нас.
   */
  async afterRun(runId: string, usedContinues: number, nowMs = Date.now()): Promise<RefundOrder[]> {
    const unused = await this.purchases.unusedGrants(runId, usedContinues);
    const orders = await Promise.all(unused.map((purchaseId) => this.request(purchaseId, "unused", nowMs)));
    return orders.flat();
  }

  /** Возвраты, заказанные до перезапуска и ещё не подтверждённые. */
  async pending(limit: number): Promise<RefundOrder[]> {
    return await this.purchases.pendingRefunds(limit);
  }

  /** Сам возврат — задание очереди. Бросает, если его стоит повторить. */
  async refund(order: RefundOrder, nowMs = Date.now()): Promise<void> {
    try {
      await this.api.refundStarPayment(order.userId, order.chargeId);
    } catch (error: unknown) {
      if (!(error instanceof TelegramApiError)) throw error;
      if (!ALREADY_REFUNDED.test(error.message)) {
        // Сеть, `429` и сбои Telegram проходят сами — повтор с паузой. Прочие
        // `400` не пройдут никогда: это разбор для человека, а не для очереди.
        if (error.errorCode === 400) {
          this.log("error", "refund_rejected", { ...describe(order), reason: error.message });
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }
    }
    if (order.purchaseId !== null) await this.purchases.markRefunded(order.chargeId, new Date(nowMs));
    this.log("log", "refund_done", describe(order));
  }

  private async request(purchaseId: string, reason: "test_mode" | "unused", nowMs: number): Promise<RefundOrder[]> {
    const order = await this.purchases.requestRefund(purchaseId, reason, new Date(nowMs));
    return order === null ? [] : [order];
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

function describe(order: RefundOrder): Record<string, unknown> {
  return { purchaseId: order.purchaseId, chargeId: order.chargeId, userId: order.userId, reason: order.reason };
}
