import { Module } from "@nestjs/common";
import { LEDGER_REPOSITORY, PrismaLedgerRepository } from "./ledger.repository.js";
import { LedgerService } from "./ledger.service.js";

/**
 * Журнал учёта (docs/37-accounting.md, Р219): план счетов, проводки двойной записью, остатки и страницы
 * журнала. Проводки пишет только сервер — платежи (T-0458), позже операции панели; маршруты чтения — в панели
 * (`admin/admin-ledger.controller.ts`). Правила проводки — ядро `@bh/ledger`, без Nest и Prisma.
 */
@Module({
  providers: [LedgerService, { provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository }],
  exports: [LedgerService],
})
export class LedgerModule {}
