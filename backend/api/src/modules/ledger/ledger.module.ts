import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FxModule } from "../fx/fx.module.js";
import { MediaModule } from "../media/media.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { LedgerSyncJob, LedgerSyncPass } from "./ledger-sync.job.js";
import { LEDGER_CHART_REPOSITORY, PrismaLedgerChartRepository } from "./ledger-chart.repository.js";
import { LedgerChartService } from "./ledger-chart.service.js";
import { LEDGER_REPOSITORY, PrismaLedgerRepository } from "./ledger.repository.js";
import { LedgerService } from "./ledger.service.js";
import { OperationApprovals } from "./operations/approval.js";
import { OperationsNotifier } from "./operations/operations-notify.js";
import { OPERATIONS_REPOSITORY, PrismaOperationsRepository } from "./operations/operations.repository.js";
import { OperationsService } from "./operations/operations.service.js";
import { PAYMENT_POSTINGS_REPOSITORY, PrismaPaymentPostingsRepository } from "./payment-postings.repository.js";
import { FinanceChat } from "./payouts/finance-chat.js";
import { PayoutPeriodHooks } from "./payouts/payout-hooks.js";
import { PayoutLock } from "./payouts/payout-lock.js";
import { PayoutNotices } from "./payouts/payout-notices.js";
import { PAYOUT_SUPPORT, PayoutSupportService } from "./payouts/payout-support.js";
import { PAYOUTS_REPOSITORY, PrismaPayoutsRepository } from "./payouts/payouts.repository.js";
import { PayoutsService } from "./payouts/payouts.service.js";
import { PERIOD_HOOKS } from "./periods/period-hooks.js";
import { PERIODS_REPOSITORY } from "./periods/period-types.js";
import { PrismaPeriodsRepository } from "./periods/periods.repository.js";
import { PeriodsService } from "./periods/periods.service.js";
import { PrismaTemplatesRepository, TEMPLATES_REPOSITORY } from "./templates/templates.repository.js";
import { TemplatesService } from "./templates/templates.service.js";

/**
 * Журнал учёта (docs/37-accounting.md, Р219): план счетов, проводки двойной записью, остатки и страницы
 * журнала. Проводки пишет только сервер — платежи (T-0458), операции панели; маршруты — в панели
 * (`admin/admin-ledger.controller.ts`). Правила проводки — ядро `@bh/ledger`, без Nest и Prisma. Места хранения
 * и статьи учёта (Р220, T-0460) — `LedgerChartService`: справочник из панели, счёт статьи в валюте заводится сам.
 * Проводки из платежей (Р219, T-0458) — задание сверки `LedgerSyncJob`: раз в десять минут сверяет `purchase`
 * с журналом и досоздаёт оплату, выход из холда и возврат; модуль платежей не трогает, только читает его таблицу.
 * Ручные операции (Р220, T-0461) — `OperationsService`: человек описывает событие, сервер собирает проводку;
 * размер операции оценивается по курсам, поэтому нужен модуль курсов. Шаблоны повторяющихся расходов (Р220, T-0463) —
 * `TemplatesService`: «Расходы месяца» создаёт по ним черновики операций, проводит их человек. Второй ключ
 * (Р220, T-0462) — `OperationApprovals`: крупная операция финансов ждёт владельца, карточку в поток «Бухгалтерия»
 * шлёт `OperationsNotifier` через порт мессенджера, снимок чека лежит в хранилище картинок (`MediaModule`),
 * имя автора в карточке берётся из аккаунтов (`AuthModule`).
 * Месяцы учёта (Р222, T-0468) — `PeriodsService`: сверка, закрытие с водопадом, снятие закрытия; закрытый месяц
 * запирает журнал замком в транзакции вставки проводки (`PrismaLedgerRepository.insertEntry`).
 * Подтверждение отчёта участниками, выплаты и сообщения (Р222, T-0469) — `payouts/`: выплата — вид операции
 * (`PAYOUT_SUPPORT` даёт сервису операций данные месяца, замок и сообщение «выплачено»), месяцы знают о выплатах через
 * хуки `PERIOD_HOOKS`, а сообщения участнику идут уведомлениями игрока (`NotificationsModule`).
 */
@Module({
  imports: [FxModule, MediaModule, AuthModule, NotificationsModule],
  providers: [
    LedgerService,
    LedgerChartService,
    OperationsService,
    PeriodsService,
    TemplatesService,
    PayoutsService,
    PayoutNotices,
    PayoutLock,
    FinanceChat,
    PayoutSupportService,
    PayoutPeriodHooks,
    OperationApprovals,
    OperationsNotifier,
    LedgerSyncPass,
    LedgerSyncJob,
    { provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository },
    { provide: LEDGER_CHART_REPOSITORY, useClass: PrismaLedgerChartRepository },
    { provide: OPERATIONS_REPOSITORY, useClass: PrismaOperationsRepository },
    { provide: TEMPLATES_REPOSITORY, useClass: PrismaTemplatesRepository },
    { provide: PAYMENT_POSTINGS_REPOSITORY, useClass: PrismaPaymentPostingsRepository },
    { provide: PERIODS_REPOSITORY, useClass: PrismaPeriodsRepository },
    { provide: PAYOUTS_REPOSITORY, useClass: PrismaPayoutsRepository },
    { provide: PAYOUT_SUPPORT, useExisting: PayoutSupportService },
    { provide: PERIOD_HOOKS, useExisting: PayoutPeriodHooks },
  ],
  exports: [LedgerService, LedgerChartService, OperationsService, TemplatesService, PeriodsService, PayoutsService],
})
export class LedgerModule {}
