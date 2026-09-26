import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { friendIdSchema, friendRequestSchema } from "./dto/friends.dto.js";
import { FRIENDS_LIMITS } from "./friends-rules.js";
import { FriendsService, type ClaimResult, type FriendsView, type RequestResult } from "./friends.service.js";

/**
 * Раздел «Друзья» игрока (docs/35-stage4-plan.md, WP14). Всё — под токеном
 * сессии: дружба бывает только между аккаунтами.
 */
@Controller("friends")
@UseGuards(AuthGuard)
export class FriendsController {
  constructor(
    private readonly friends: FriendsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: FriendsView }> {
    const account = accountOf(request);
    await this.limit(FRIENDS_LIMITS.read, account.accountId);
    return { data: await this.friends.view(account.accountId) };
  }

  /** Ссылка дружбы — одна и постоянная: повторный вызов отдаёт ту же. */
  @Post("link")
  async link(@Req() request: unknown): Promise<{ data: { code: string; startParam: string } }> {
    const account = accountOf(request);
    await this.limit(FRIENDS_LIMITS.change, account.accountId);
    return { data: await this.friends.link(account.accountId) };
  }

  @Post("requests")
  async request(@Req() request: unknown, @Body() body: unknown): Promise<{ data: RequestResult }> {
    const account = accountOf(request);
    const parsed = friendRequestSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Некорректная заявка");
    await this.limit(FRIENDS_LIMITS.request, account.accountId);
    return { data: await this.friends.request(account, parsed.data.accountId) };
  }

  @Post("requests/:accountId/accept")
  async accept(@Req() request: unknown, @Param("accountId") from: string): Promise<{ data: { status: "friends" } }> {
    const account = accountOf(request);
    await this.limit(FRIENDS_LIMITS.change, account.accountId);
    return { data: await this.friends.accept(account, idOf(from)) };
  }

  @Post("requests/:accountId/decline")
  async decline(@Req() request: unknown, @Param("accountId") from: string): Promise<{ data: { declined: boolean } }> {
    const account = accountOf(request);
    await this.limit(FRIENDS_LIMITS.change, account.accountId);
    return { data: await this.friends.decline(account, idOf(from)) };
  }

  /** Отменить свою заявку. */
  @Delete("requests/:accountId")
  async cancel(@Req() request: unknown, @Param("accountId") to: string): Promise<{ data: { cancelled: boolean } }> {
    const account = accountOf(request);
    await this.limit(FRIENDS_LIMITS.change, account.accountId);
    return { data: await this.friends.cancel(account, idOf(to)) };
  }

  /** Забрать подарки друзей — до потолка игровых суток. */
  @Post("gifts/claim")
  async claimGifts(@Req() request: unknown): Promise<{ data: ClaimResult }> {
    const account = accountOf(request);
    await this.limit(FRIENDS_LIMITS.change, account.accountId);
    return { data: await this.friends.claimGifts(account) };
  }

  /** Забрать бонус за число друзей — все достигнутые ступени разом. */
  @Post("bonus/claim")
  async claimBonus(@Req() request: unknown): Promise<{ data: ClaimResult }> {
    const account = accountOf(request);
    await this.limit(FRIENDS_LIMITS.change, account.accountId);
    return { data: await this.friends.claimBonus(account) };
  }

  @Post(":accountId/gift")
  async gift(@Req() request: unknown, @Param("accountId") friend: string): Promise<{ data: { sent: boolean } }> {
    const account = accountOf(request);
    await this.limit(FRIENDS_LIMITS.change, account.accountId);
    return { data: await this.friends.sendGift(account, idOf(friend)) };
  }

  @Delete(":accountId")
  async remove(@Req() request: unknown, @Param("accountId") friend: string): Promise<{ data: { removed: boolean } }> {
    const account = accountOf(request);
    await this.limit(FRIENDS_LIMITS.change, account.accountId);
    return { data: await this.friends.remove(account, idOf(friend)) };
  }

  private async limit(rule: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(rule, accountId))) throw new RateLimitedError("Слишком часто — подождите");
  }
}

function idOf(value: string): string {
  const parsed = friendIdSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Некорректный игрок");
  return parsed.data;
}
