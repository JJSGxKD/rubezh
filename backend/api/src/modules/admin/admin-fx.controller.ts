import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { manualRateSchema } from "../fx/dto/fx.dto.js";
import { FxService, type FxOverview, type ManualView } from "../fx/fx.service.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Курсы валют в панели (docs/35-stage4-plan.md, §3.12): обзор со свежестью
 * и бюджетами источников, заданные курсы звёзд — цена для игрока и выплата нам.
 * Те же вызовы, что у `/fx/admin`, но под cookie-сессией панели.
 */
@Controller("admin/fx")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminFxController {
  constructor(
    private readonly fx: FxService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("analytics.revenue.view")
  async overview(): Promise<{ data: FxOverview }> {
    return { data: await this.fx.overview() };
  }

  @Post("manual")
  @RequirePermission("fx.rates.edit")
  async setManual(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ManualView }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return { data: await this.fx.setManual(actor, parse(() => manualRateSchema.parse(body), "Некорректный курс")) };
  }
}
