import { Module } from "@nestjs/common";
import { LEDGER_CHART_REPOSITORY, PrismaLedgerChartRepository } from "./ledger-chart.repository.js";
import { LedgerChartService } from "./ledger-chart.service.js";
import { LEDGER_REPOSITORY, PrismaLedgerRepository } from "./ledger.repository.js";
import { LedgerService } from "./ledger.service.js";

/**
 * Журнал учёта (docs/37-accounting.md, Р219): план счетов, проводки двойной записью, остатки и страницы
 * журнала. Проводки пишет только сервер — платежи (T-0458), позже операции панели; маршруты чтения — в панели
 * (`admin/admin-ledger.controller.ts`). Правила проводки — ядро `@bh/ledger`, без Nest и Prisma. Места хранения
 * и статьи учёта (Р220, T-0460) — `LedgerChartService`: справочник из панели, счёт статьи в валюте заводится сам.
 */
@Module({
  providers: [LedgerService, LedgerChartService, { provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository }, { provide: LEDGER_CHART_REPOSITORY, useClass: PrismaLedgerChartRepository }],
  exports: [LedgerService, LedgerChartService],
})
export class LedgerModule {}
