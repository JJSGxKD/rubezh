import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { customerReportQuerySchema, loadCustomerReport, type CustomerReport } from "../tasks/customer-report.js";
import { CUSTOMER_REPORT_REPOSITORY, type CustomerReportRepository } from "../tasks/customer-report.repository.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Отчёт заказчику партнёрских заданий (docs/35-stage4-plan.md Р140,
 * tasks/T-0225): по дням и заданиям — показы, нажатия, выполнения, удержание
 * и сумма к оплате. Смотрят под `partners.view`; CSV панель собирает из этого
 * же ответа (скачивание — право `data.export`, как у других выгрузок).
 * В ответе только счётчики: ни аккаунтов, ни имён, ни площадок игроков.
 *
 * Лимита частоты нет, как у других чтений панели: период не длиннее 92 дней,
 * выборки сужены периодом: события — по индексу вида и времени приёма, заборы — по сроку забора.
 */
@Controller("admin/customer-report")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminCustomerReportController {
  constructor(@Inject(CUSTOMER_REPORT_REPOSITORY) private readonly repository: CustomerReportRepository) {}

  /** Заказчики из заданий — для выбора на экране. */
  @Get("customers")
  @RequirePermission("partners.view")
  async customers(): Promise<{ data: { customers: string[] } }> {
    return { data: { customers: await this.repository.customers() } };
  }

  @Get()
  @RequirePermission("partners.view")
  async report(@Query() query: unknown): Promise<{ data: CustomerReport }> {
    const parsed = parse(() => customerReportQuerySchema.parse(query), "Некорректный заказчик или период (не длиннее 92 дней)");
    return { data: await loadCustomerReport(this.repository, parsed) };
  }
}
