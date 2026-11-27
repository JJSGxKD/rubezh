import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { appearanceChoiceSchema, type AppearanceChoice, type AppearanceView } from "./appearance-rules.js";
import { AppearanceService } from "./appearance.service.js";

/**
 * Облики героя (`/api/v1/appearance`, tasks/T-0237, docs/35-stage4-plan.md Р150): раздел
 * «Облики» игрока и выбор облика и кружка аватара. Только своё — аккаунт из токена. Облик в
 * строках списков кладут рейтинг, сезон и друзья через порт `PublicIdentity`, не эти ручки.
 *
 * Лимит — по аккаунту, как у знаков: раздел открывают при входе на экран, облик меняют редко.
 */
const LIMIT: RateLimit = { scope: "appearance:view", limit: 300, windowSec: 3600 };
const CHOOSE_LIMIT: RateLimit = { scope: "appearance:choose", limit: 60, windowSec: 3600 };

@Controller("appearance")
@UseGuards(AuthGuard)
export class AppearanceController {
  constructor(
    private readonly appearance: AppearanceService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Все облики каталога с отметкой «держит», источником и выбором. */
  @Get()
  async view(@Req() request: unknown): Promise<{ data: AppearanceView }> {
    const { accountId } = accountOf(request);
    await this.limit(LIMIT, accountId);
    return { data: await this.appearance.viewFor(accountId) };
  }

  /** Выбрать облик и/или кружок аватара: `{ id?, avatarPhoto? }`, хотя бы одно поле. */
  @Put()
  async choose(@Req() request: unknown, @Body() body: unknown): Promise<{ data: AppearanceChoice }> {
    const { accountId } = accountOf(request);
    const parsed = appearanceChoiceSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Нужен id облика или выбор аватара: id, avatarPhoto или оба");
    await this.limit(CHOOSE_LIMIT, accountId);
    return { data: await this.appearance.choose(accountId, parsed.data) };
  }

  private async limit(limit: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
