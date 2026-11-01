import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { favoritesSchema, type AchievementsSummary, type AchievementsView } from "./achievement-rules.js";
import { AchievementsService } from "./achievements.service.js";

/**
 * Витрина достижений (`/api/v1/achievements`, tasks/T-0106): список с прогрессом,
 * редкостью и престижем, сводка для профиля и три любимых. Только своё — аккаунт
 * из токена; чужие достижения этими ручками не читаются. Награду за достижение
 * по-прежнему забирает `POST /tasks/:id/claim`.
 *
 * Лимит — по аккаунту: за адресом мобильного оператора стоят сотни игроков. Витрину
 * открывают при входе на экран, избранное меняют редко.
 */
const LIMIT: RateLimit = { scope: "achievements", limit: 300, windowSec: 3600 };
const FAVORITES_LIMIT: RateLimit = { scope: "achievements:favorites", limit: 60, windowSec: 3600 };

@Controller("achievements")
@UseGuards(AuthGuard)
export class AchievementsController {
  constructor(
    private readonly achievements: AchievementsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: AchievementsView }> {
    const account = accountOf(request);
    await this.limit(LIMIT, account.accountId);
    return { data: await this.achievements.view(account) };
  }

  /** Престиж и любимые — для профиля, без списка. */
  @Get("summary")
  async summary(@Req() request: unknown): Promise<{ data: AchievementsSummary }> {
    const { accountId } = accountOf(request);
    await this.limit(LIMIT, accountId);
    return { data: await this.achievements.summary(accountId) };
  }

  /** Заменить любимые: порядок `ids` — порядок слотов, пустой список очищает. */
  @Put("favorites")
  async favorites(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { favorites: string[] } }> {
    const { accountId } = accountOf(request);
    const parsed = favoritesSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Любимых достижений не больше трёх, без повторов");
    await this.limit(FAVORITES_LIMIT, accountId);
    return { data: await this.achievements.setFavorites(accountId, parsed.data.ids) };
  }

  private async limit(limit: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
