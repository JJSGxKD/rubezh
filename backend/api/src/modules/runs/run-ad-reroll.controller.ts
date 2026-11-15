import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { runIdParamSchema } from "./dto/runs.dto.js";
import { RunAdRerollService, type AdRerollView } from "./run-ad-reroll.service.js";
import { RUNS_LIMITS } from "./runs-limits.js";

/**
 * Переброс карточек за рекламу (`/api/v1/runs/:runId/rerolls/ad`,
 * docs/35-stage4-plan.md Р133): можно ли перебросить и сам переброс по
 * сессии показа. Только свой забег — аккаунт из токена.
 */

/** Идентификатор сессии показа — как его выдаёт модуль рекламы (`ads.controller.ts`). */
const claimSchema = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{16}$/) }).strict();

@Controller("runs")
@UseGuards(AuthGuard)
export class RunAdRerollController {
  constructor(
    private readonly rerolls: RunAdRerollService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get(":runId/rerolls/ad")
  async view(@Req() request: unknown, @Param("runId") runId: string): Promise<{ data: AdRerollView }> {
    const { accountId, platform } = accountOf(request);
    const run = runIdParamSchema.safeParse(runId);
    if (!run.success) throw new ValidationError("Некорректный забег");
    await this.limit(accountId);
    return { data: await this.rerolls.view({ accountId, platform }, run.data) };
  }

  @Post(":runId/rerolls/ad")
  @HttpCode(200)
  async claim(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: { granted: true } }> {
    const { accountId, platform } = accountOf(request);
    const run = runIdParamSchema.safeParse(runId);
    const parsed = claimSchema.safeParse(body);
    if (!run.success || !parsed.success) throw new ValidationError("Некорректный забег или показ");
    await this.limit(accountId);
    return { data: await this.rerolls.claim({ accountId, platform }, run.data, parsed.data.sessionId) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(RUNS_LIMITS.adReroll, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
