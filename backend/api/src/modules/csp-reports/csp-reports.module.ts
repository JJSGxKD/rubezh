import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { CspReportsAdminController, CspReportsController } from "./csp-reports.controller.js";
import { CSP_REPORTS_REPOSITORY, RedisCspReportsRepository } from "./csp-reports.repository.js";
import { CspReportsService } from "./csp-reports.service.js";

/**
 * Отчёты политики источников (Р108, docs/35-stage4-plan.md; tasks/T-0155):
 * браузер присылает отчёт о каждом заблокированном адресе, сервер хранит
 * сводку в Redis, панель её читает. Базы нет, другие модули сводку не берут.
 *
 * Гард панели приходит из `AdminModule`, который экспортирует его для таких модулей.
 */
@Module({
  imports: [AdminModule],
  controllers: [CspReportsController, CspReportsAdminController],
  providers: [{ provide: CSP_REPORTS_REPOSITORY, useClass: RedisCspReportsRepository }, CspReportsService, RateLimiter],
})
export class CspReportsModule {}
