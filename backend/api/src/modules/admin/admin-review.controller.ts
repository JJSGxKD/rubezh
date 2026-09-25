import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { RunsViewService } from "../runs/runs-view.service.js";
import type { ReviewRow } from "../runs/runs.repository.js";
import { FUNNEL_REPOSITORY, type FunnelRepository } from "../funnel/funnel.repository.js";
import type { FunnelRow } from "../funnel/funnel-report.js";
import { parse, periodOf } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { periodQuerySchema, reviewLimitSchema } from "./dto/admin.dto.js";

/**
 * Очередь разбора забегов и воронка по источникам в панели
 * (docs/35-stage4-plan.md, WP17 п. 3 и 7). Оба раздела читают то, что уже
 * умеют модули забегов и воронки; панель лишь другой вход к тем же данным.
 */
@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminReviewController {
  constructor(
    private readonly runs: RunsViewService,
    @Inject(FUNNEL_REPOSITORY) private readonly funnel: FunnelRepository,
  ) {}

  /** Подозрительные и отклонённые забеги, свежие первыми. */
  @Get("runs/review")
  @RequirePermission("players.view")
  async review(@Query("limit") limit?: string): Promise<{ data: { runs: ReviewRow[] } }> {
    const parsed = parse(() => reviewLimitSchema.parse(limit ?? undefined), "Некорректный предел");
    return { data: { runs: await this.runs.review(parsed) } };
  }

  /** Сколько аккаунтов дошло до каждой вехи — по площадке, виду и коду источника первого касания. */
  @Get("funnel")
  @RequirePermission("analytics.gameplay.view")
  async funnelReport(@Query() query: unknown): Promise<{ data: { from: string; to: string; rows: FunnelRow[] } }> {
    const period = periodOf(parse(() => periodQuerySchema.parse(query), "Некорректный период"), new Date());
    return { data: { from: period.from.toISOString(), to: period.to.toISOString(), rows: await this.funnel.report(period.from, period.to) } };
  }
}
