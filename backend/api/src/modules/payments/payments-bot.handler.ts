import { Injectable, type OnModuleInit } from "@nestjs/common";
import { BotRouter, type BotUpdateHandler } from "../bot/bot-router.js";
import type { TelegramUpdate } from "../telegram/telegram-bot-api.js";
import { PaymentConfirmation } from "./payment-confirmation.js";
import { PaymentsQueue } from "./payments-queue.js";

/**
 * Обновления оплаты от Telegram — в общем маршрутизаторе бота рядом с
 * командами: откуда пришло обновление, опросом или вебхуком, оплате всё
 * равно.
 *
 * Зарегистрирован, даже когда продажа выключена (`PAYMENTS_ENABLED=false`):
 * по старой ссылке на счёт игрок может дойти до оплаты и после выключения, и
 * тогда проверка обязана отказать, а подтверждение, если оно всё же пришло, —
 * записаться. Не зарегистрирован без базы: оплату некуда записать.
 */
@Injectable()
export class PaymentsBotHandler implements BotUpdateHandler, OnModuleInit {
  readonly name = "payments";

  constructor(
    private readonly router: BotRouter,
    private readonly confirmation: PaymentConfirmation,
    private readonly queue: PaymentsQueue,
  ) {}

  onModuleInit(): void {
    if (this.queue.enabled) this.router.register(this);
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    const query = update.pre_checkout_query;
    if (query !== undefined) {
      await this.confirmation.answerCheckout({
        queryId: query.id,
        fromUserId: query.from.id,
        currency: query.currency,
        totalAmount: query.total_amount,
        payload: query.invoice_payload,
      });
      return true;
    }

    const message = update.message;
    if (message?.successful_payment !== undefined) {
      const payment = message.successful_payment;
      await this.queue.confirm({
        chargeId: payment.telegram_payment_charge_id,
        payload: payment.invoice_payload,
        // Оплата приходит в личный чат с игроком: без отправителя его id — это id чата.
        userId: message.from?.id ?? message.chat.id,
        currency: payment.currency,
        totalAmount: payment.total_amount,
      });
      return true;
    }
    if (message?.refunded_payment !== undefined) {
      await this.confirmation.refunded(message.refunded_payment.telegram_payment_charge_id);
      return true;
    }
    return false;
  }
}
