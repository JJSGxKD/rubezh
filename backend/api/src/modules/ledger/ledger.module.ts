import { Module } from "@nestjs/common";
import { LedgerSyncJob, LedgerSyncPass } from "./ledger-sync.job.js";
import { LEDGER_CHART_REPOSITORY, PrismaLedgerChartRepository } from "./ledger-chart.repository.js";
import { LedgerChartService } from "./ledger-chart.service.js";
import { LEDGER_REPOSITORY, PrismaLedgerRepository } from "./ledger.repository.js";
import { LedgerService } from "./ledger.service.js";
import { PAYMENT_POSTINGS_REPOSITORY, PrismaPaymentPostingsRepository } from "./payment-postings.repository.js";

/**
 * Журнал учёта (docs/37-accounting.md, Р219): план счетов, проводки двойной записью, остатки и страницы
 * журнала. Проводки пишет только сервер — платежи (T-0458), позже операции панели; маршруты чтения — в панели
 * (`admin/admin-ledger.controller.ts`). Правила проводки — ядро `@bh/ledger`, без Nest и Prisma. Места хранения
 * и статьи учёта (Р220, T-0460) — `LedgerChartService`: справочник из панели, счёт статьи в валюте заводится сам.
 * Проводки из платежей (Р219, T-0458) — задание сверки `LedgerSyncJob`: раз в десять минут сверяет `purchase`
 * с журналом и досоздаёт оплату, выход из холда и возврат; модуль платежей не трогает, только читает его таблицу.
 */
@Module({
  providers: [
    LedgerService,
    LedgerChartService,
    LedgerSyncPass,
    LedgerSyncJob,
    { provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository },
    { provide: LEDGER_CHART_REPOSITORY, useClass: PrismaLedgerChartRepository },
    { provide: PAYMENT_POSTINGS_REPOSITORY, useClass: PrismaPaymentPostingsRepository },
  ],
  exports: [LedgerService, LedgerChartService],
})
export class LedgerModule {}
