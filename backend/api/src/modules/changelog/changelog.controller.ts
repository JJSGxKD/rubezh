import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { CHANGELOG_PAGE_MAX, VERSION_PATTERN, type ChangelogPage } from "./changelog-rules.js";
import { ChangelogService } from "./changelog.service.js";

/**
 * Журнал обновлений игрока (`/api/v1/changelog`, docs/35-stage4-plan.md
 * WP31): строки его площадки по версиям и отметка «открывал». Площадка — из
 * токена: чужой журнал не спросить. Знак меню приходит со знаками
 * (`badges/`).
 */
const LIMIT: RateLimit = { scope: "changelog", limit: 300, windowSec: 3600 };

const pageQuerySchema = z.object({
  cursor: z.string().regex(VERSION_PATTERN).optional(),
  limit: z.coerce.number().int().min(1).max(CHANGELOG_PAGE_MAX).optional(),
});

const seenSchema = z.object({ upTo: z.iso.datetime() });

@Controller("changelog")
@UseGuards(AuthGuard)
export class ChangelogController {
  constructor(
    private readonly changelog: ChangelogService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async page(@Req() request: unknown, @Query() query: unknown): Promise<{ data: ChangelogPage }> {
    const account = accountOf(request);
    await this.limit(account.accountId);
    const parsed = pageQuerySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError("Некорректный запрос журнала");
    return { data: await this.changelog.page(account, parsed.data.cursor ?? null, parsed.data.limit) };
  }

  @Post("seen")
  @HttpCode(200)
  async seen(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { badge: number } }> {
    const account = accountOf(request);
    await this.limit(account.accountId);
    const parsed = seenSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError("Некорректная отметка журнала");
    await this.changelog.markSeen(account.accountId, new Date(parsed.data.upTo));
    return { data: { badge: await this.changelog.badge(account) } };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
