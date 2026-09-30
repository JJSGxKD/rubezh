import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { WheelService, type WheelSpinResult, type WheelView } from "./wheel.service.js";

/**
 * Колесо (`/api/v1/wheel`, docs/35-stage4-plan.md WP13): сектора с шансами и
 * крутка. Только своё — аккаунт из токена. В теле крутки — только чем
 * крутят; что выпало, решает сервер.
 */
const LIMIT: RateLimit = { scope: "wheel", limit: 120, windowSec: 3600 };

/** Крутка за рекламу придёт с проверкой просмотра (WP12) — тогда здесь появится `ad`. */
const spinSchema = z.object({ source: z.enum(["free"]) }).strict();

@Controller("wheel")
@UseGuards(AuthGuard)
export class WheelController {
  constructor(
    private readonly wheel: WheelService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: WheelView }> {
    const { accountId } = accountOf(request);
    await this.limit(accountId);
    return { data: await this.wheel.view(accountId) };
  }

  @Post("spin")
  @HttpCode(200)
  async spin(@Req() request: unknown, @Body() body: unknown): Promise<{ data: WheelSpinResult }> {
    const { accountId } = accountOf(request);
    if (!spinSchema.safeParse(body).success) throw new ValidationError("Неизвестный вид крутки");
    await this.limit(accountId);
    return { data: await this.wheel.spin(accountId) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
