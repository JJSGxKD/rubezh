import { Controller, Get, Inject, Param, Query, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import { DIAGNOSTICS_REPOSITORY, type DiagnosticsRepository, type ReportListRow, type StoredReport } from "../diagnostics/diagnostics.repository.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { RolesService } from "../roles/roles.service.js";
import { ReportNotFoundError } from "./admin-errors.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { reportIdSchema, reportsListSchema } from "./dto/admin.dto.js";

/**
 * Отчёты диагностики в панели (docs/28-diagnostics.md §5; docs/29-admin-panel.md
 * §2). Список — без тяжёлого `payload`, отчёт целиком — по идентификатору.
 * Telegram ID тестера в отчёте — персональные данные: без права на них он
 * скрыт, а просмотр с правом — в журнале.
 */
@Controller("admin/diagnostics/reports")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminDiagnosticsController {
  constructor(
    @Inject(DIAGNOSTICS_REPOSITORY) private readonly reports: DiagnosticsRepository,
    private readonly roles: RolesService,
  ) {}

  @Get()
  @RequirePermission("diagnostics.view")
  async list(@Req() request: unknown, @Query() query: unknown): Promise<{ data: { reports: ReportListRow[] } }> {
    const filter = parse(() => reportsListSchema.parse(query), "Некорректный запрос списка отчётов");
    const withPii = await this.roles.can(accountOf(request), "players.pii.view");
    const rows = await this.reports.list(filter);
    return { data: { reports: rows.map((row) => (withPii ? row : { ...row, platformUserId: null })) } };
  }

  @Get(":reportId")
  @RequirePermission("diagnostics.view")
  async one(@Req() request: unknown, @Param("reportId") reportId: string): Promise<{ data: StoredReport }> {
    const id = parse(() => reportIdSchema.parse(reportId), "Некорректный идентификатор отчёта");
    const report = await this.reports.find(id);
    if (report === null) throw new ReportNotFoundError();

    const actor = accountOf(request);
    const withPii = await this.roles.can(actor, "players.pii.view");
    if (withPii && report.platformUserId !== null) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "players.pii.view", target: `report:${id}` });
    }
    return { data: withPii ? report : { ...report, platformUserId: null } };
  }
}
