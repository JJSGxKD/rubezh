import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { runIdParamSchema } from "./dto/runs.dto.js";
import { RunAdChestService, type AdChestView } from "./run-ad-chest.service.js";
import { RUNS_LIMITS } from "./runs-limits.js";

/**
 * Второй сундук клада за рекламу (`/api/v1/runs/:runId/chests/ad`,
 * docs/35-stage4-plan.md Р162): можно ли взять и сам сундук по сессии показа.
 * Только свой забег — аккаунт из токена.
 */

/** Идентификатор сессии показа — как его выдаёт модуль рекламы (`ads.controller.ts`). */
const claimSchema = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{16}$/) }).strict();

@Controller("runs")
@UseGuards(AuthGuard)
export class RunAdChestController {
  constructor(
    private readonly chests: RunAdChestService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get(":runId/chests/ad")
  async view(@Req() request: unknown, @Param("runId") runId: string): Promise<{ data: AdChestView }> {
    const { accountId, platform } = accountOf(request);
    const run = runIdParamSchema.safeParse(runId);
    if (!run.success) throw new ValidationError("Некорректный забег");
    await this.limit(accountId);
    return { data: await this.chests.view({ accountId, platform }, run.data) };
  }

  @Post(":runId/chests/ad")
  @HttpCode(200)
  async claim(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: { granted: true } }> {
    const { accountId, platform } = accountOf(request);
    const run = runIdParamSchema.safeParse(runId);
    const parsed = claimSchema.safeParse(body);
    if (!run.success || !parsed.success) throw new ValidationError("Некорректный забег или показ");
    await this.limit(accountId);
    return { data: await this.chests.claim({ accountId, platform }, run.data, parsed.data.sessionId) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(RUNS_LIMITS.adChest, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
