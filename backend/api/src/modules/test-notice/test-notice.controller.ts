import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { TestNoticeService, type TestNoticeView } from "./test-notice.service.js";

/**
 * Предупреждение об открытом тесте (`/api/v1/me/test-notice`,
 * docs/35-stage4-plan.md WP33): принятая версия и принятие. Только своё —
 * аккаунт из токена.
 */
const LIMIT: RateLimit = { scope: "test-notice", limit: 120, windowSec: 3600 };

/** Версия текста у клиента — небольшое целое; больше тысячи правок предупреждение не переживёт. */
const acceptSchema = z.object({ version: z.number().int().min(1).max(1_000) }).strict();

@Controller("me/test-notice")
@UseGuards(AuthGuard)
export class TestNoticeController {
  constructor(
    private readonly notice: TestNoticeService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: TestNoticeView }> {
    const { accountId } = accountOf(request);
    await this.limit(accountId);
    return { data: await this.notice.view(accountId) };
  }

  @Post()
  @HttpCode(200)
  async accept(@Req() request: unknown, @Body() body: unknown): Promise<{ data: TestNoticeView }> {
    const { accountId } = accountOf(request);
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Неизвестная версия предупреждения");
    await this.limit(accountId);
    return { data: await this.notice.accept(accountId, parsed.data.version) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
