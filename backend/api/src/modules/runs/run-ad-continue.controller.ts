import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { runIdParamSchema } from "./dto/runs.dto.js";
import { RunAdContinueService, type AdContinueView } from "./run-ad-continue.service.js";
import { RUNS_LIMITS } from "./runs-limits.js";

/**
 * Второй шанс за рекламу (`/api/v1/runs/:runId/continues/ad`,
 * docs/35-stage4-plan.md WP11): можно ли продолжить и само продолжение по
 * сессии показа. Только свой забег — аккаунт из токена.
 */

/** Идентификатор сессии показа — как его выдаёт модуль рекламы (`ads.controller.ts`). */
const claimSchema = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{16}$/) }).strict();

@Controller("runs")
@UseGuards(AuthGuard)
export class RunAdContinueController {
  constructor(
    private readonly continues: RunAdContinueService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get(":runId/continues/ad")
  async view(@Req() request: unknown, @Param("runId") runId: string): Promise<{ data: AdContinueView }> {
    const { accountId, platform } = accountOf(request);
    const run = runIdParamSchema.safeParse(runId);
    if (!run.success) throw new ValidationError("Некорректный забег");
    await this.limit(accountId);
    return { data: await this.continues.view({ accountId, platform }, run.data) };
  }

  @Post(":runId/continues/ad")
  @HttpCode(200)
  async claim(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: { continueNo: number } }> {
    const { accountId, platform } = accountOf(request);
    const run = runIdParamSchema.safeParse(runId);
    const parsed = claimSchema.safeParse(body);
    if (!run.success || !parsed.success) throw new ValidationError("Некорректный забег или показ");
    await this.limit(accountId);
    return { data: await this.continues.claim({ accountId, platform }, run.data, parsed.data.sessionId) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(RUNS_LIMITS.adContinue, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
