import { Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { DailyService, type DailyClaimResult, type DailyView } from "./daily.service.js";

/**
 * Награда дня (`/api/v1/daily`, docs/35-stage4-plan.md WP13): неделя и забор.
 * Только своё — аккаунт из токена; тела у забора нет: что забирать, решает
 * сервер по московским суткам.
 */
const LIMIT: RateLimit = { scope: "daily", limit: 120, windowSec: 3600 };

@Controller("daily")
@UseGuards(AuthGuard)
export class DailyController {
  constructor(
    private readonly daily: DailyService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: DailyView }> {
    const { accountId } = accountOf(request);
    await this.limit(accountId);
    return { data: await this.daily.view(accountId) };
  }

  @Post("claim")
  @HttpCode(200)
  async claim(@Req() request: unknown): Promise<{ data: DailyClaimResult }> {
    const { accountId } = accountOf(request);
    await this.limit(accountId);
    return { data: await this.daily.claim(accountId) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
