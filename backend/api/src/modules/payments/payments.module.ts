import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { BotModule } from "../bot/bot.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { PaymentConfirmation } from "./payment-confirmation.js";
import { PaymentsBotHandler } from "./payments-bot.handler.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsQueue } from "./payments-queue.js";
import { PaymentsService } from "./payments.service.js";
import { PrismaPurchasesRepository, PURCHASES_REPOSITORY } from "./purchases.repository.js";

/**
 * Второй шанс за Telegram Stars (docs/34-stage3-plan.md, WP5): цена, счёт,
 * подтверждение оплаты ботом и состояние покупки. Продажа выключена по
 * умолчанию (`PAYMENTS_ENABLED`).
 *
 * Забеги модуль читает, но не принимает: продолжение продаётся к забегу,
 * который начался на сервере, — отсюда зависимость от `RunsModule`, а не
 * наоборот. Обновления оплаты приходят через общий маршрутизатор бота.
 */
@Module({
  imports: [AuthModule, RunsModule, BotModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentConfirmation,
    PaymentsQueue,
    PaymentsBotHandler,
    { provide: PURCHASES_REPOSITORY, useClass: PrismaPurchasesRepository },
  ],
})
export class PaymentsModule {}
