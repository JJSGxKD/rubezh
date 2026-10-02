import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { AdminOverviewService, type Overview } from "./admin-overview.service.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Сводка — первый экран панели для тех, кому открыта аналитика. */
@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get("overview")
  @RequirePermission("analytics.gameplay.view")
  async get(@Req() request: unknown): Promise<{ data: Overview }> {
    return { data: await this.overview.overview(accountOf(request)) };
  }
}
