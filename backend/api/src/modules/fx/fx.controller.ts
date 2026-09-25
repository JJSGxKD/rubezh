import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { manualRateSchema } from "./dto/fx.dto.js";
import { FxService, type FxOverview, type ManualView } from "./fx.service.js";

/**
 * Курсы в панели (docs/35-stage4-plan.md, §3.12, WP17). Игроку курсы не
 * отдаются: он видит цены, а не курсы, по которым они посчитаны.
 */

const MANUAL_LIMIT: RateLimit = { scope: "fx:manual", limit: 30, windowSec: 3600 };

@Controller("fx")
@UseGuards(AuthGuard, PermissionGuard)
export class FxController {
  constructor(
    private readonly fx: FxService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Курсы, их свежесть, заданные курсы и бюджеты источников. */
  @Get("admin")
  @RequirePermission("analytics.revenue.view")
  async overview(): Promise<{ data: FxOverview }> {
    return { data: await this.fx.overview() };
  }

  @Post("admin/manual")
  @RequirePermission("fx.rates.edit")
  async setManual(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ManualView }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(MANUAL_LIMIT, actor.accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    return { data: await this.fx.setManual(actor, parse(() => manualRateSchema.parse(body), "Некорректный курс")) };
  }
}

function parse<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new ValidationError(message);
    throw error;
  }
}
