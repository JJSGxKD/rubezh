import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { PaymentsContinueLedger } from "./continue-ledger.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PaymentConfirmation } from "./payment-confirmation.js";
import { PaymentRefunds } from "./payment-refunds.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsQueue } from "./payments-queue.js";
import { PaymentsService } from "./payments.service.js";
import { PrismaPurchasesRepository, PURCHASES_REPOSITORY } from "./purchases.repository.js";

/**
 * Второй шанс за Telegram Stars (docs/34-stage3-plan.md, WP5): цена, счёт,
 * подтверждение оплаты ботом, возвраты и состояние покупки. Продажа
 * выключена по умолчанию (`PAYMENTS_ENABLED`), тестовая оплата — только в
 * разработке (`PAYMENTS_TEST_MODE`).
 *
 * Забеги модуль читает, но не принимает: продолжение продаётся к забегу,
 * который начался на сервере, — отсюда зависимость от `RunsModule`, а не
 * наоборот; сверку продолжений в итоге забега модуль подключает к приёму
 * забегов сам (`continue-ledger.ts`). Площадку модуль видит только через
 * порт оплаты; что площадка сообщает об оплате, приносит её адаптер
 * (`platforms/telegram/telegram-payments.module.ts`).
 */
@Module({
  imports: [AuthModule, RunsModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentConfirmation,
    PaymentRefunds,
    PaymentsQueue,
    PaymentsContinueLedger,
    PaymentsHooks,
    { provide: PURCHASES_REPOSITORY, useClass: PrismaPurchasesRepository },
  ],
  exports: [PaymentConfirmation, PaymentsQueue, PaymentsHooks],
})
export class PaymentsModule {}
