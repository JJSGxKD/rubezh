import { Module } from "@nestjs/common";
import { EXPORT_REPOSITORY, PrismaExportRepository } from "./export.repository.js";
import { ExportService } from "./export.service.js";
import { RetentionJob } from "./retention.job.js";

/**
 * Данные закрытого теста наружу и их срок жизни (docs/28-diagnostics.md §5.4,
 * §6): выгрузка архивом и очистка старше `DIAGNOSTICS_RETENTION_DAYS`.
 * Доставку выгрузки ведёт бот, запасной путь — `pnpm closed-test:export`.
 */
@Module({
  providers: [ExportService, RetentionJob, { provide: EXPORT_REPOSITORY, useClass: PrismaExportRepository }],
  exports: [ExportService],
})
export class ExportModule {}
