import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { FEED_PAGE_MAX, NotificationsService, type FeedView } from "./notifications.service.js";

/**
 * Лента уведомлений игрока (`/api/v1/me/notifications`, docs/35-stage4-plan.md
 * §3.17). Число непрочитанного для колокольчика приходит со знаками меню
 * (`badges/`), здесь — лента и отметка прочитанного. Только своё: аккаунт
 * из токена.
 */
const LIMIT: RateLimit = { scope: "notifications", limit: 600, windowSec: 3600 };

const feedQuerySchema = z.object({
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(FEED_PAGE_MAX).optional(),
});

const readSchema = z.object({ upTo: z.string().uuid().optional() });

@Controller("me/notifications")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async feed(@Req() request: unknown, @Query() query: unknown): Promise<{ data: FeedView }> {
    const account = accountOf(request);
    await this.limit(account.accountId);
    const parsed = feedQuerySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError("Некорректный запрос ленты");
    return { data: await this.notifications.feed(account.accountId, parsed.data.cursor, parsed.data.limit) };
  }

  @Post("read")
  async read(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { unread: number } }> {
    const account = accountOf(request);
    await this.limit(account.accountId);
    const parsed = readSchema.safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError("Некорректное уведомление");
    return { data: await this.notifications.read(account.accountId, parsed.data.upTo) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
