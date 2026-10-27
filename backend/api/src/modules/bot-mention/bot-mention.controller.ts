import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { BOT_MENTION_KINDS } from "./bot-mention-rules.js";
import { BotMentionService, type BotMentionCheck, type BotMentionView } from "./bot-mention.service.js";

/**
 * Задания «юзернейм бота» (`/api/v1/bot-mention`, docs/35-stage4-plan.md Р110):
 * что вписать и сколько за это платят, и ручная проверка вида. Только своё —
 * аккаунт из токена. Тела у проверки нет: исход решает площадка, награду —
 * настройки панели, клиент не присылает ничего.
 */
const LIMIT: RateLimit = { scope: "bot-mention", limit: 300, windowSec: 3600 };
/** Проверка — запрос к площадке от имени бота, поэтому лимит ниже: нажимают её единицы раз в сутки. */
const CHECK_LIMIT: RateLimit = { scope: "bot-mention-check", limit: 20, windowSec: 3600 };
const KIND = z.enum(BOT_MENTION_KINDS);

@Controller("bot-mention")
@UseGuards(AuthGuard)
export class BotMentionController {
  constructor(
    private readonly service: BotMentionService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: BotMentionView }> {
    const account = accountOf(request);
    await this.limit(account.accountId, LIMIT);
    return { data: await this.service.view(account) };
  }

  @Post(":kind/check")
  @HttpCode(200)
  async check(@Req() request: unknown, @Param("kind") kind: string): Promise<{ data: BotMentionCheck }> {
    const account = accountOf(request);
    const parsed = KIND.safeParse(kind);
    if (!parsed.success) throw new ValidationError("Неверный вид задания");
    await this.limit(account.accountId, CHECK_LIMIT);
    return { data: await this.service.check(account, parsed.data) };
  }

  private async limit(accountId: string, limit: RateLimit): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
