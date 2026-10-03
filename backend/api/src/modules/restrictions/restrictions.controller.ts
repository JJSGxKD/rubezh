import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { AccountRestrictions } from "./account-restrictions.js";
import type { PlayerRestrictionView } from "./restriction-rules.js";

/**
 * Свои ограничения игрока (`/api/v1/me/restrictions`, docs/35-stage4-plan.md
 * WP44): что закрыто, до какого числа и почему — для плашки там, где игрок
 * упёрся, и для списка в профиле. Молчаливые сюда не попадают.
 */
const LIMIT: RateLimit = { scope: "restrictions:me", limit: 120, windowSec: 3600 };

@Controller("me/restrictions")
@UseGuards(AuthGuard)
export class RestrictionsController {
  constructor(
    private readonly restrictions: AccountRestrictions,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async mine(@Req() request: unknown): Promise<{ data: { restrictions: PlayerRestrictionView[] } }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    return { data: { restrictions: await this.restrictions.visibleFor(account.accountId) } };
  }
}
