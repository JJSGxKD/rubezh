import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { DailyDoubleService, type DailyDoubleResult, type DailyViewWithDouble } from "./daily-double.service.js";
import { DailyService, type DailyClaimResult } from "./daily.service.js";

/**
 * Награда дня (`/api/v1/daily`, docs/35-stage4-plan.md WP13): неделя, забор и
 * удвоение за ролик (Р155, T-0242). Только своё — аккаунт из токена; тела у
 * забора нет: что забирать, решает сервер по московским суткам.
 */
const LIMIT: RateLimit = { scope: "daily", limit: 120, windowSec: 3600 };

/** Идентификатор сессии показа — как его выдаёт модуль рекламы (`ads.controller.ts`). */
const doubleSchema = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{16}$/) }).strict();

type DailyClaimResponse = Omit<DailyClaimResult, "view"> & { view: DailyViewWithDouble };

@Controller("daily")
@UseGuards(AuthGuard)
export class DailyController {
  constructor(
    private readonly daily: DailyService,
    private readonly double: DailyDoubleService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: DailyViewWithDouble }> {
    const { accountId, platform } = accountOf(request);
    await this.limit(accountId);
    const [view, double] = await Promise.all([this.daily.view(accountId), this.double.view({ accountId, platform })]);
    return { data: { ...view, double } };
  }

  @Post("claim")
  @HttpCode(200)
  async claim(@Req() request: unknown): Promise<{ data: DailyClaimResponse }> {
    const { accountId, platform } = accountOf(request);
    await this.limit(accountId);
    const claimed = await this.daily.claim(accountId);
    // После забора игрок сразу видит, можно ли удвоить, — отдельный запрос экрану не нужен.
    return { data: { ...claimed, view: { ...claimed.view, double: await this.double.view({ accountId, platform }) } } };
  }

  @Post("double")
  @HttpCode(200)
  async doubleClaim(@Req() request: unknown, @Body() body: unknown): Promise<{ data: DailyDoubleResult }> {
    const { accountId, platform } = accountOf(request);
    const parsed = doubleSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Некорректный показ");
    await this.limit(accountId);
    return { data: await this.double.double({ accountId, platform }, parsed.data.sessionId) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
