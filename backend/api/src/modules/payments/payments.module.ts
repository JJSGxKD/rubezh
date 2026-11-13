import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { PaymentsContinueLedger } from "./continue-ledger.js";
import { FulfillmentSweeper } from "./fulfillment-sweeper.js";
import { PaymentFeedSources } from "./payment-feed-sources.js";
import { PaymentJobs } from "./payment-jobs.js";
import { PaymentRetry } from "./payment-retry.js";
import { PAYMENTS_FEED_REPOSITORY, PrismaPaymentsFeedRepository } from "./payments-feed.repository.js";
import { PaymentsFeed } from "./payments-feed.service.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PaymentConfirmation } from "./payment-confirmation.js";
import { PaymentRefunds } from "./payment-refunds.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsQueue } from "./payments-queue.js";
import { PaymentsService } from "./payments.service.js";
import { PurchaseCompensations } from "./purchase-compensation.js";
import { PURCHASE_COMPENSATION_REPOSITORY, PrismaPurchaseCompensationRepository } from "./purchase-compensation.repository.js";
import { PurchaseFulfillment } from "./purchase-fulfillment.js";
import { PurchaseRevocation } from "./purchase-revocation.js";
import { PurchaseSupport } from "./purchase-support.js";
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
  imports: [AuthModule, RunsModule, RestrictionsModule, WalletModule],
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
    PurchaseRevocation,
    PurchaseSupport,
    SubscriptionRenewal,
    PaymentsFeed,
    PaymentFeedSources,
    PaymentJobs,
    PaymentRetry,
    PurchaseCompensations,
    { provide: PURCHASES_REPOSITORY, useClass: PrismaPurchasesRepository },
    { provide: PAYMENTS_FEED_REPOSITORY, useClass: PrismaPaymentsFeedRepository },
    { provide: PURCHASE_COMPENSATION_REPOSITORY, useClass: PrismaPurchaseCompensationRepository },
  ],
  // Репозиторий — карточке игрока в панели: покупки аккаунта читаются, не меняются.
  // Сервис и выдача — магазину и VIP: они выставляют счета на товары и выдают их;
  // отзыв остатка при возврате — им же; продление подписки — VIP. Поддержка покупок —
  // панели: маршруты и карточка игрока (`admin/admin-purchases.controller.ts`). Лента платежей —
  // панели же (`admin/admin-payments.controller.ts`), а реестр источников хронологии — модулям, которые
  // добавляют в карточку платежа свои строки: брошенные задания, сверка, компенсация (Р209). Брошенные
  // задания очереди и «Повторить учёт» (`PaymentJobs`, `PaymentRetry`) — панели: `admin/admin-payment-jobs.controller.ts`.
  // Компенсация за сбой оплаты — панели же (`admin/admin-payment-compensation.controller.ts`):
  // кошелёк подключён ради неё, цикла нет — кошелёк платежей не знает.
  exports: [PaymentConfirmation, PaymentsQueue, PaymentsHooks, PaymentsService, PurchaseFulfillment, PurchaseRevocation, PurchaseSupport, SubscriptionRenewal, PURCHASES_REPOSITORY, PaymentsFeed, PaymentFeedSources, PaymentJobs, PaymentRetry, PurchaseCompensations],
})
export class PaymentsModule {}
