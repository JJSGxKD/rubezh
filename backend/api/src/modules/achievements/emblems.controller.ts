import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { emblemChoiceSchema, type EmblemsView } from "./emblem-rules.js";
import { EmblemsService, type EmblemChoice } from "./emblems.service.js";

/**
 * Знаки у имени (`/api/v1/achievements/emblems`, tasks/T-0235, docs/35-stage4-plan.md Р149):
 * раздел «Знаки» игрока и выбор знака, который он носит у имени. Только своё — аккаунт из токена.
 * Знак в строках списков кладут рейтинг, сезон и друзья через `EmblemsService.of`, не эти ручки.
 *
 * Лимит — по аккаунту: раздел открывают при входе на экран, знак меняют редко.
 */
const LIMIT: RateLimit = { scope: "achievements:emblems", limit: 300, windowSec: 3600 };
const CHOOSE_LIMIT: RateLimit = { scope: "achievements:emblem", limit: 60, windowSec: 3600 };

@Controller("achievements")
@UseGuards(AuthGuard)
export class EmblemsController {
  constructor(
    private readonly emblems: EmblemsService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Все знаки каталога с отметкой «держит» и тем, какой носится. */
  @Get("emblems")
  async view(@Req() request: unknown): Promise<{ data: EmblemsView }> {
    const { accountId } = accountOf(request);
    await this.limit(LIMIT, accountId);
    return { data: await this.emblems.listFor(accountId) };
  }

  /** Выбрать знак; `{ id: null }` возвращает «по умолчанию». */
  @Put("emblem")
  async choose(@Req() request: unknown, @Body() body: unknown): Promise<{ data: EmblemChoice }> {
    const { accountId } = accountOf(request);
    const parsed = emblemChoiceSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Нужен id знака или null — вернуть знак по умолчанию");
    await this.limit(CHOOSE_LIMIT, accountId);
    return { data: await this.emblems.choose(accountId, parsed.data.id) };
  }

  private async limit(limit: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
