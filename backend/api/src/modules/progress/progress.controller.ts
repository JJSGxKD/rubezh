import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { ProgressService, type ProgressView, type RunRewardView } from "./progress.service.js";

/**
 * Уровень аккаунта и награда за забег (docs/35-stage4-plan.md, WP4). Экран
 * итогов спрашивает награду несколько раз, пока задание очереди её не
 * посчитает, — отсюда лимит щедрее, чем у приёма забегов.
 */

const READ_LIMIT: RateLimit = { scope: "progress:read", limit: 900, windowSec: 3600 };
const runIdSchema = z.string().min(1).max(64);

@Controller("progress")
@UseGuards(AuthGuard)
export class ProgressController {
  constructor(
    private readonly progress: ProgressService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async mine(@Req() request: unknown): Promise<{ data: ProgressView }> {
    const account = accountOf(request);
    await this.limit(account.accountId);
    return { data: await this.progress.view(account.accountId) };
  }

  @Get("runs/:runId")
  async runReward(@Req() request: unknown, @Param("runId") runId: string): Promise<{ data: RunRewardView }> {
    const account = accountOf(request);
    await this.limit(account.accountId);
    const parsed = runIdSchema.safeParse(runId);
    if (!parsed.success) throw new ValidationError("Некорректный забег");
    return { data: await this.progress.runReward(account.accountId, parsed.data) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(READ_LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
