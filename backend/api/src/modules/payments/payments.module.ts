import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { PaymentsContinueLedger } from "./continue-ledger.js";
import { FulfillmentSweeper } from "./fulfillment-sweeper.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PaymentConfirmation } from "./payment-confirmation.js";
import { PaymentRefunds } from "./payment-refunds.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsQueue } from "./payments-queue.js";
import { PaymentsService } from "./payments.service.js";
import { PurchaseFulfillment } from "./purchase-fulfillment.js";
import { PrismaPurchasesRepository, PURCHASES_REPOSITORY } from "./purchases.repository.js";
import { SubscriptionRenewal } from "./subscription-renewal.js";

/**
 * Оплата через площадку: второй шанс за Telegram Stars (docs/34-stage3-plan.md,
 * WP5), товары магазина и подписка VIP (docs/35-stage4-plan.md, WP10) — цена,
 * счёт, подтверждение оплаты ботом, продления подписки, возвраты, выдача и
 * состояние покупки. Продажа
 * возможна при входе и чтении обновлений бота; стоп-кран — настройка
 * `payments.stars` (запасное значение — `PAYMENTS_ENABLED`), тестовая оплата
 * — только в разработке (`PAYMENTS_TEST_MODE`).
 *
 * Оплаченное не остаётся без выдачи: проход довыдачи подбирает покупки, у
 * которых задание очереди сдалось, и выдаёт их или возвращает звёзды
 * (`fulfillment-sweeper.ts`).
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
    FulfillmentSweeper,
    PaymentsContinueLedger,
    PaymentsHooks,
    PurchaseFulfillment,
    SubscriptionRenewal,
    { provide: PURCHASES_REPOSITORY, useClass: PrismaPurchasesRepository },
  ],
  // Репозиторий — карточке игрока в панели: покупки аккаунта читаются, не меняются.
  // Сервис и выдача — магазину и VIP: они выставляют счета на товары и выдают их;
  // продление подписки — VIP.
  exports: [PaymentConfirmation, PaymentsQueue, PaymentsHooks, PaymentsService, PurchaseFulfillment, SubscriptionRenewal, PURCHASES_REPOSITORY],
})
export class PaymentsModule {}
