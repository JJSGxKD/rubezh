import { Module } from "@nestjs/common";
import { DiagnosticsController } from "./diagnostics.controller.js";
import { DiagnosticsHooks } from "./diagnostics-hooks.js";
import { DIAGNOSTICS_REPOSITORY, PrismaDiagnosticsRepository } from "./diagnostics.repository.js";
import { DiagnosticsService } from "./diagnostics.service.js";

/**
 * Отчёты диагностики в Postgres (docs/28-diagnostics.md §5): стресс-тест, а
 * позже и запись забега. Выключен по умолчанию — `DIAGNOSTICS_INGEST_ENABLED`.
 * Кто хочет знать о новых отчётах, подписывается через `DiagnosticsHooks`.
 */
@Module({
  controllers: [DiagnosticsController],
  providers: [
    DiagnosticsService,
    DiagnosticsHooks,
    { provide: DIAGNOSTICS_REPOSITORY, useClass: PrismaDiagnosticsRepository },
  ],
  exports: [DiagnosticsHooks, DIAGNOSTICS_REPOSITORY],
})
export class DiagnosticsModule {}
