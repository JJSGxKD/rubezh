import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { WheelService, type WheelSource, type WheelSpinResult, type WheelView } from "./wheel.service.js";

/**
 * Колесо (`/api/v1/wheel`, docs/35-stage4-plan.md WP13): сектора с шансами и
 * крутка. Только своё — аккаунт из токена. В теле крутки — только чем
 * крутят: бесплатной круткой суток или досмотренной рекламой (сессия показа
 * WP12); что выпало, решает сервер.
 */
const LIMIT: RateLimit = { scope: "wheel", limit: 120, windowSec: 3600 };

/** Идентификатор сессии показа — как его выдаёт модуль рекламы (`ads.controller.ts`). */
const spinSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("free") }).strict(),
  z.object({ source: z.literal("ad"), sessionId: z.string().regex(/^[A-Za-z0-9_-]{16}$/) }).strict(),
]);

@Controller("wheel")
@UseGuards(AuthGuard)
export class WheelController {
  constructor(
    private readonly wheel: WheelService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: WheelView }> {
    const { accountId, platform } = accountOf(request);
    await this.limit(accountId);
    return { data: await this.wheel.view({ accountId, platform }) };
  }

  @Post("spin")
  @HttpCode(200)
  async spin(@Req() request: unknown, @Body() body: unknown): Promise<{ data: WheelSpinResult }> {
    const { accountId, platform } = accountOf(request);
    const parsed = spinSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Неизвестный вид крутки");
    await this.limit(accountId);
    const source: WheelSource = parsed.data.source === "free" ? { kind: "free" } : { kind: "ad", sessionId: parsed.data.sessionId };
    return { data: await this.wheel.spin({ accountId, platform }, source) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
