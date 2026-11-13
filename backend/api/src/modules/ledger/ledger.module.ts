import { Module } from "@nestjs/common";
import { FxModule } from "../fx/fx.module.js";
import { LedgerSyncJob, LedgerSyncPass } from "./ledger-sync.job.js";
import { LEDGER_CHART_REPOSITORY, PrismaLedgerChartRepository } from "./ledger-chart.repository.js";
import { LedgerChartService } from "./ledger-chart.service.js";
import { LEDGER_REPOSITORY, PrismaLedgerRepository } from "./ledger.repository.js";
import { LedgerService } from "./ledger.service.js";
import { OPERATIONS_REPOSITORY, PrismaOperationsRepository } from "./operations/operations.repository.js";
import { OperationsService } from "./operations/operations.service.js";
import { PAYMENT_POSTINGS_REPOSITORY, PrismaPaymentPostingsRepository } from "./payment-postings.repository.js";
import { NoPeriodHooks, PERIOD_HOOKS } from "./periods/period-hooks.js";
import { PERIOD_LOCK, PrismaPeriodLock } from "./periods/period-lock.js";
import { PERIODS_REPOSITORY } from "./periods/period-types.js";
import { PrismaPeriodsRepository } from "./periods/periods.repository.js";
import { PeriodsService } from "./periods/periods.service.js";

/**
 * Журнал учёта (docs/37-accounting.md, Р219): план счетов, проводки двойной записью, остатки и страницы
 * журнала. Проводки пишет только сервер — платежи (T-0458), операции панели; маршруты — в панели
 * (`admin/admin-ledger.controller.ts`). Правила проводки — ядро `@bh/ledger`, без Nest и Prisma. Места хранения
 * и статьи учёта (Р220, T-0460) — `LedgerChartService`: справочник из панели, счёт статьи в валюте заводится сам.
 * Проводки из платежей (Р219, T-0458) — задание сверки `LedgerSyncJob`: раз в десять минут сверяет `purchase`
 * с журналом и досоздаёт оплату, выход из холда и возврат; модуль платежей не трогает, только читает его таблицу.
 * Ручные операции (Р220, T-0461) — `OperationsService`: человек описывает событие, сервер собирает проводку;
 * размер операции оценивается по курсам, поэтому нужен модуль курсов.
 * Месяцы учёта (Р222, T-0468) — `PeriodsService`: сверка, закрытие с водопадом, снятие закрытия; закрытый месяц
 * запирает журнал через `PERIOD_LOCK`, а выплаты по месяцу (T-0469) подключаются хуками `PERIOD_HOOKS`.
 */
@Module({
  imports: [FxModule],
  providers: [
    LedgerService,
    LedgerChartService,
    OperationsService,
    PeriodsService,
    LedgerSyncPass,
    LedgerSyncJob,
    { provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository },
    { provide: LEDGER_CHART_REPOSITORY, useClass: PrismaLedgerChartRepository },
    { provide: OPERATIONS_REPOSITORY, useClass: PrismaOperationsRepository },
    { provide: PAYMENT_POSTINGS_REPOSITORY, useClass: PrismaPaymentPostingsRepository },
    { provide: PERIODS_REPOSITORY, useClass: PrismaPeriodsRepository },
    { provide: PERIOD_LOCK, useClass: PrismaPeriodLock },
    { provide: PERIOD_HOOKS, useClass: NoPeriodHooks },
  ],
  exports: [LedgerService, LedgerChartService, OperationsService, PeriodsService],
})
export class LedgerModule {}
