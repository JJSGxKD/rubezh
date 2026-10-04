import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { HomeService, type HomeView } from "./home.service.js";

/**
 * Главная (`/api/v1/me/home`, docs/35-stage4-plan.md WP42): карусель —
 * слайды по ценности для игрока — и виджеты. Только своё: аккаунт из
 * токена, поэтому под `me`, как знаки меню. Клиент спрашивает при заходе на
 * главную: ответ свежий минуту, раньше — только если с тех пор обновились
 * знаки меню (забег, забор награды, возврат в приложение).
 */
const LIMIT: RateLimit = { scope: "home", limit: 600, windowSec: 3600 };

@Controller("me/home")
@UseGuards(AuthGuard)
export class HomeController {
  constructor(
    private readonly home: HomeService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: HomeView }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    return { data: await this.home.view(account) };
  }
}
