import { Injectable, type OnModuleInit } from "@nestjs/common";
import { PaymentConfirmation } from "../../modules/payments/payment-confirmation.js";
import { PaymentsQueue } from "../../modules/payments/payments-queue.js";
import { BotRouter, type BotUpdateHandler } from "./bot-router.js";
import type { TelegramUpdate } from "./telegram-bot-api.js";

/**
 * Что Telegram сообщает об оплате — в общем маршрутизаторе бота рядом с
 * командами: откуда пришло обновление, опросом или вебхуком, оплате всё
 * равно. Обработчик только переводит обновление в вызов домена оплаты: что
 * с ним делать, решает домен.
 *
 * Зарегистрирован, даже когда продажа выключена (`PAYMENTS_ENABLED=false`):
 * по старой ссылке на счёт игрок может дойти до оплаты и после выключения, и
 * тогда проверка обязана отказать, а подтверждение, если оно всё же пришло, —
 * записаться. Не зарегистрирован без базы: оплату некуда записать.
 */
@Injectable()
export class TelegramPaymentsHandler implements BotUpdateHandler, OnModuleInit {
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
        platform: "telegram",
        queryId: query.id,
        payerId: String(query.from.id),
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
        platform: "telegram",
        chargeId: payment.telegram_payment_charge_id,
        payload: payment.invoice_payload,
        // Оплата приходит в личный чат с игроком: без отправителя его id — это id чата.
        payerId: String(message.from?.id ?? message.chat.id),
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
