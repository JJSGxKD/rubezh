import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { RunDoubleService, type RunDoubleResult, type RunDoubleView } from "./run-double.service.js";

/**
 * Удвоение награды за забег за рекламу (`/api/v1/progress/runs/:runId/double`,
 * docs/35-stage4-plan.md WP12): можно ли удвоить и само удвоение по
 * досмотренной сессии показа. Только свой забег — аккаунт из токена.
 */
const LIMIT: RateLimit = { scope: "progress:double", limit: 300, windowSec: 3600 };

const runIdSchema = z.string().min(1).max(64);
/** Идентификатор сессии показа — как его выдаёт модуль рекламы (`ads.controller.ts`). */
const doubleSchema = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{16}$/) }).strict();

@Controller("progress/runs")
@UseGuards(AuthGuard)
export class RunDoubleController {
  constructor(
    private readonly doubles: RunDoubleService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get(":runId/double")
  async view(@Req() request: unknown, @Param("runId") runId: string): Promise<{ data: RunDoubleView }> {
    const { accountId, platform } = accountOf(request);
    const parsed = runIdSchema.safeParse(runId);
    if (!parsed.success) throw new ValidationError("Некорректный забег");
    await this.limit(accountId);
    return { data: await this.doubles.view({ accountId, platform }, parsed.data) };
  }

  @Post(":runId/double")
  @HttpCode(200)
  async double(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: RunDoubleResult }> {
    const { accountId, platform } = accountOf(request);
    const run = runIdSchema.safeParse(runId);
    const parsed = doubleSchema.safeParse(body);
    if (!run.success || !parsed.success) throw new ValidationError("Некорректный забег или показ");
    await this.limit(accountId);
    return { data: await this.doubles.double({ accountId, platform }, run.data, parsed.data.sessionId) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
