import { Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { CompensationService, type ClaimResult, type CompensationView } from "./compensation.service.js";

/**
 * Компенсация тестеру после вайпа (`/api/v1/me/compensation`,
 * docs/35-stage4-plan.md Р87, WP33): что положено и выдача по кнопке «Забрать».
 * Только своё — аккаунт из токена.
 */
const CLAIM_LIMIT: RateLimit = { scope: "me:compensation", limit: 10, windowSec: 60 };

@Controller("me/compensation")
@UseGuards(AuthGuard)
export class CompensationController {
  constructor(
    private readonly compensation: CompensationService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Положенное, пока не забрано; нет компенсации или уже забрано — `null`. */
  @Get()
  async pending(@Req() request: unknown): Promise<{ data: CompensationView | null }> {
    const { accountId } = accountOf(request);
    return { data: await this.compensation.pending(accountId) };
  }

  /** Тела нет: что выдавать, сервер знает по снимку. Повтор отвечает тем же результатом. */
  @Post("claim")
  @HttpCode(200)
  async claim(@Req() request: unknown): Promise<{ data: ClaimResult }> {
    const { accountId } = accountOf(request);
    if (!(await this.limiter.consume(CLAIM_LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуй через минуту");
    return { data: await this.compensation.claim(accountId) };
  }
}
