import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import type { FeedView } from "./feed-events.js";
import { FeedService } from "./feed.service.js";

/**
 * Клиент спрашивает ленту раз в `feed.refresh-sec` (по умолчанию 300 с, то есть
 * 12 раз в час); 120 в час — запас на несколько вкладок и повторные заходы, а
 * больше — уже скрипт.
 */
const FEED_LIMIT: RateLimit = { scope: "feed", limit: 120, windowSec: 3600 };

/**
 * Лента живых событий на главной (`GET /api/v1/feed`, tasks/T-0174). Тела и
 * параметров нет: лента одна для всех, фильтров игроку не дают.
 */
@Controller("feed")
@UseGuards(AuthGuard)
export class FeedController {
  constructor(
    private readonly feed: FeedService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: FeedView }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(FEED_LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
    return { data: await this.feed.view(new Date()) };
  }
}
