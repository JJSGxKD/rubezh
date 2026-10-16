import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { MessagingService } from "./messaging.service.js";

/**
 * Можно ли боту писать игроку (`/api/v1/me/messaging`, tasks/T-0010): клиент
 * решает по ответу, звать ли «Разрешить сообщения от бота». Причину и время
 * изменения наружу не отдаём — клиенту нужен только ответ «да» или «нет».
 * Читают при заходе на главную и в настройки — сотня в час честно.
 */
const LIMIT: RateLimit = { scope: "messaging:read", limit: 300, windowSec: 3600 };

@Controller("me/messaging")
@UseGuards(AuthGuard)
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async get(@Req() request: unknown): Promise<{ data: { canMessage: boolean } }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    const state = await this.messaging.state(account.accountId);
    return { data: { canMessage: state?.canMessage ?? false } };
  }
}
