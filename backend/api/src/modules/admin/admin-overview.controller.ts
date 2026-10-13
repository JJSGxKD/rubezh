import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { parse } from "./admin-parse.js";
import { AdminOverviewService, type Overview, type OverviewPeriod } from "./admin-overview.service.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Период сводки: параметр приходит строкой; пусто — сутки, как до периодов. */
const querySchema = z.object({ days: z.enum(["1", "7", "30"]).default("1") });

/** Сводка — первый экран панели для тех, кому открыта аналитика. */
@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get("overview")
  @RequirePermission("analytics.gameplay.view")
  async get(@Req() request: unknown, @Query() query: unknown): Promise<{ data: Overview }> {
    const { days } = parse(() => querySchema.parse(query), "Период — 1, 7 или 30 дней");
    return { data: await this.overview.overview(accountOf(request), Number(days) as OverviewPeriod) };
  }
}
