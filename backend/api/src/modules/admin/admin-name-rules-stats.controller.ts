import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import { NameRulesStatsService, type NameRuleStatsView } from "../name-rules/name-rules-stats.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Статистика срабатываний правил фильтра имён в панели (Р168, tasks/T-0340):
 * `GET /admin/name-rules/stats?days=7|30|90`, по умолчанию 30. Право — `names.edit`.
 * Только чтение: счётчики пишет вход игрока, а не панель.
 */
const querySchema = z.strictObject({ days: z.coerce.number().int().optional() });

@Controller("admin/name-rules/stats")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminNameRulesStatsController {
  constructor(private readonly stats: NameRulesStatsService) {}

  @Get()
  @RequirePermission("names.edit")
  async read(@Req() request: unknown, @Query() query: unknown): Promise<{ data: NameRuleStatsView }> {
    const { days } = parse(() => querySchema.parse(query), "Окно — 7, 30 или 90 суток");
    return { data: await this.stats.stats(accountOf(request), days ?? 30) };
  }
}
