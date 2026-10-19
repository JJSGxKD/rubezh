import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { boardQuerySchema, seasonKeyParamSchema, type BoardView, type ClaimResult, type Overview } from "./dto/seasons.dto.js";
import { SeasonsClaimService } from "./seasons-claim.service.js";
import { SEASONS_LIMITS } from "./seasons-limits.js";
import { SeasonsViewService } from "./seasons-view.service.js";

/**
 * Недельный сезон рейтинга (`/api/v1/seasons`, tasks/T-0110): обзор, таблица
 * недели и «Забрать». В контроллере нет логики — только разбор границы и
 * форма ответа (docs/15-engineering-standards.md §2.3). Всё под `AuthGuard`:
 * награда принадлежит аккаунту.
 */
@Controller("seasons")
@UseGuards(AuthGuard)
export class SeasonsController {
  constructor(
    private readonly view: SeasonsViewService,
    private readonly claims: SeasonsClaimService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async overview(@Req() request: unknown): Promise<{ data: Overview }> {
    const { accountId } = accountOf(request);
    await this.limit(SEASONS_LIMITS.overview, accountId);
    return { data: await this.view.overview(accountId) };
  }

  @Get("board")
  async board(@Req() request: unknown, @Query() query: unknown): Promise<{ data: BoardView }> {
    const { accountId } = accountOf(request);
    await this.limit(SEASONS_LIMITS.board, accountId);
    const parsed = parse(() => boardQuerySchema.parse(query), "Неизвестная сложность или охват таблицы");
    return { data: await this.view.board(accountId, parsed) };
  }

  @Post(":key/claim")
  @HttpCode(200)
  async claim(@Req() request: unknown, @Param("key") key: string): Promise<{ data: ClaimResult }> {
    const { accountId } = accountOf(request);
    await this.limit(SEASONS_LIMITS.claim, accountId);
    const seasonKey = parse(() => seasonKeyParamSchema.parse(key), "Некорректный сезон");
    return { data: await this.claims.claim(accountId, seasonKey) };
  }

  private async limit(rule: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(rule, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}

function parse<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new ValidationError(message);
    throw error;
  }
}
