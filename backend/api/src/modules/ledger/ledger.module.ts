import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FxModule } from "../fx/fx.module.js";
import { MediaModule } from "../media/media.module.js";
import { LEDGER_CHART_REPOSITORY, PrismaLedgerChartRepository } from "./ledger-chart.repository.js";
import { LedgerChartService } from "./ledger-chart.service.js";
import { LEDGER_REPOSITORY, PrismaLedgerRepository } from "./ledger.repository.js";
import { LedgerService } from "./ledger.service.js";
import { OperationApprovals } from "./operations/approval.js";
import { OperationsNotifier } from "./operations/operations-notify.js";
import { OPERATIONS_REPOSITORY, PrismaOperationsRepository } from "./operations/operations.repository.js";
import { OperationsService } from "./operations/operations.service.js";

/**
 * Журнал учёта (docs/37-accounting.md, Р219): план счетов, проводки двойной записью, остатки и страницы
 * журнала. Проводки пишет только сервер — платежи (T-0458), операции панели; маршруты — в панели
 * (`admin/admin-ledger.controller.ts`). Правила проводки — ядро `@bh/ledger`, без Nest и Prisma. Места хранения
 * и статьи учёта (Р220, T-0460) — `LedgerChartService`: справочник из панели, счёт статьи в валюте заводится сам.
 * Ручные операции (Р220, T-0461) — `OperationsService`: человек описывает событие, сервер собирает проводку;
 * размер операции оценивается по курсам, поэтому нужен модуль курсов. Второй ключ (Р220, T-0462) —
 * `OperationApprovals`: крупная операция финансов ждёт владельца, карточку в поток «Бухгалтерия» шлёт
 * `OperationsNotifier` через порт мессенджера, снимок чека лежит в хранилище картинок (`MediaModule`),
 * имя автора в карточке берётся из аккаунтов (`AuthModule`).
 */
@Module({
  imports: [FxModule, MediaModule, AuthModule],
  providers: [
    LedgerService,
    LedgerChartService,
    OperationsService,
    OperationApprovals,
    OperationsNotifier,
    { provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository },
    { provide: LEDGER_CHART_REPOSITORY, useClass: PrismaLedgerChartRepository },
    { provide: OPERATIONS_REPOSITORY, useClass: PrismaOperationsRepository },
  ],
  exports: [LedgerService, LedgerChartService, OperationsService],
})
export class LedgerModule {}
