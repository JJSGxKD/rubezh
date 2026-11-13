import { Module } from "@nestjs/common";
import { FxModule } from "../fx/fx.module.js";
import { LEDGER_CHART_REPOSITORY, PrismaLedgerChartRepository } from "./ledger-chart.repository.js";
import { LedgerChartService } from "./ledger-chart.service.js";
import { LEDGER_REPOSITORY, PrismaLedgerRepository } from "./ledger.repository.js";
import { LedgerService } from "./ledger.service.js";
import { OPERATIONS_REPOSITORY, PrismaOperationsRepository } from "./operations/operations.repository.js";
import { OperationsService } from "./operations/operations.service.js";
import { PrismaTemplatesRepository, TEMPLATES_REPOSITORY } from "./templates/templates.repository.js";
import { TemplatesService } from "./templates/templates.service.js";

/**
 * Журнал учёта (docs/37-accounting.md, Р219): план счетов, проводки двойной записью, остатки и страницы
 * журнала. Проводки пишет только сервер — платежи (T-0458), операции панели; маршруты — в панели
 * (`admin/admin-ledger.controller.ts`). Правила проводки — ядро `@bh/ledger`, без Nest и Prisma. Места хранения
 * и статьи учёта (Р220, T-0460) — `LedgerChartService`: справочник из панели, счёт статьи в валюте заводится сам.
 * Ручные операции (Р220, T-0461) — `OperationsService`: человек описывает событие, сервер собирает проводку;
 * размер операции оценивается по курсам, поэтому нужен модуль курсов. Шаблоны повторяющихся расходов (Р220, T-0463) —
 * `TemplatesService`: «Расходы месяца» создаёт по ним черновики операций, проводит их человек.
 */
@Module({
  imports: [FxModule],
  providers: [
    LedgerService,
    LedgerChartService,
    OperationsService,
    TemplatesService,
    { provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository },
    { provide: LEDGER_CHART_REPOSITORY, useClass: PrismaLedgerChartRepository },
    { provide: OPERATIONS_REPOSITORY, useClass: PrismaOperationsRepository },
    { provide: TEMPLATES_REPOSITORY, useClass: PrismaTemplatesRepository },
  ],
  exports: [LedgerService, LedgerChartService, OperationsService, TemplatesService],
})
export class LedgerModule {}
