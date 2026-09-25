import { Module } from "@nestjs/common";
import { PaymentsModule } from "../../modules/payments/payments.module.js";
import { BotModule } from "./bot.module.js";
import { TelegramPaymentsHandler } from "./telegram-payments.handler.js";

/**
 * Обновления оплаты от Telegram → домен оплаты. Отдельным модулем, чтобы
 * модуль оплаты не знал о боте: он зависит от порта, а адаптер — от него.
 */
@Module({
  imports: [PaymentsModule, BotModule],
  providers: [TelegramPaymentsHandler],
})
export class TelegramPaymentsModule {}
