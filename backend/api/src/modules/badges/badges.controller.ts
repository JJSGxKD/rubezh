import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { BadgesService, type BadgesView } from "./badges.service.js";

/**
 * Знаки меню (`/api/v1/me/badges`, docs/35-stage4-plan.md §3.17): клиент
 * спрашивает при входе, после забега и на возврате в приложение — без
 * постоянного соединения. Только своё: аккаунт из токена.
 */
const LIMIT: RateLimit = { scope: "badges", limit: 600, windowSec: 3600 };

@Controller("me/badges")
@UseGuards(AuthGuard)
export class BadgesController {
  constructor(
    private readonly badges: BadgesService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: BadgesView }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    return { data: await this.badges.view(account) };
  }
}
