import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { Public, RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { addressOf } from "../../common/request-address.js";
import { AdminSessionGuard } from "../admin/admin-session.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { CspReportsService, type CspSummary } from "./csp-reports.service.js";

/**
 * 300 в минуту с адреса: страница с десятком заблокированных адресов шлёт
 * десяток отчётов на загрузку, а мобильные операторы сажают сотни людей на
 * один адрес. Больше — уже не браузеры.
 */
const REPORT_LIMIT: RateLimit = { scope: "csp-reports:ip", limit: 300, windowSec: 60 };

/**
 * Приёмник отчётов браузера. Без входа и без `IngestGuard`: в таком запросе
 * нет ни подписи запуска, ни установки, а заголовок `Origin` не гарантирован
 * (tasks/T-0155, «Решения»). Адрес — из `req.ip` с учётом доверенных прокси.
 */
@Controller("csp-reports")
export class CspReportsController {
  constructor(
    private readonly reports: CspReportsService,
    private readonly limiter: RateLimiter,
  ) {}

  // Отчёт шлёт сам браузер, не клиент игры: токена игрока у него нет. Защита —
  // лимит по адресу, потолок тела и закрытый набор хранимых значений.
  @Public()
  @Post()
  @HttpCode(204)
  async receive(@Req() request: unknown, @Body() body: unknown): Promise<void> {
    if (!(await this.limiter.consume(REPORT_LIMIT, addressOf(request)))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    await this.reports.record(body);
  }
}

/** Сводка блокировок для панели — тем, кто разбирает отчёты устройств. */
@Controller("admin/csp-reports")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class CspReportsAdminController {
  constructor(private readonly reports: CspReportsService) {}

  @Get()
  @RequirePermission("diagnostics.view")
  async summary(): Promise<{ data: CspSummary }> {
    return { data: await this.reports.summary() };
  }
}
