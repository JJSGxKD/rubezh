import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { PlayerStyleService, type StyleSummary } from "./player-style.service.js";

/**
 * Рейтинг игрока (`/api/v1/rating`, tasks/T-0295): «Твой стиль». В контроллере
 * нет логики — только вход и лимит (docs/15-engineering-standards.md §2.3).
 * Ответ — свой, поэтому всё под `AuthGuard`, а лимит — по аккаунту: за адресом
 * мобильного оператора стоят сотни игроков.
 *
 * Лимит читают при открытии вкладки «Сезон» и после забега: сто в час живому
 * игроку с запасом. Меняется здесь, в карте конфигурации — docs/30-configuration-map.md.
 */
export const RATING_LIMITS: Record<"style", RateLimit> = {
  style: { scope: "rating:style", limit: 100, windowSec: 3600 },
};

@Controller("rating")
@UseGuards(AuthGuard)
export class RatingController {
  constructor(
    private readonly styles: PlayerStyleService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Сильная и слабая ось по последним рейтинговым забегам; меньше трёх забегов — `style: null` и сколько не хватает. */
  @Get("me/style")
  async style(@Req() request: unknown): Promise<{ data: StyleSummary }> {
    const { accountId } = accountOf(request);
    if (!(await this.limiter.consume(RATING_LIMITS.style, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
    return { data: await this.styles.myStyle(accountId) };
  }
}
