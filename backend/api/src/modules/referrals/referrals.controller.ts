import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { REFERRAL_LIMITS } from "./referral-rules.js";
import type { ReferralRow } from "./referrals.repository.js";
import { ReferralsService } from "./referrals.service.js";

/** Кого привёл игрок и кто из них активирован (docs/23-referral-and-partner-program.md §2). */
@Controller("referrals")
@UseGuards(AuthGuard)
export class ReferralsController {
  constructor(
    private readonly referrals: ReferralsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async mine(@Req() request: unknown): Promise<{ data: { referrals: ReferralRow[]; activated: number; rewardCoins: number } }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(REFERRAL_LIMITS.read, account.accountId))) throw new RateLimitedError("Слишком часто — подождите");
    return { data: await this.referrals.mine(account.accountId) };
  }
}
