import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { BattlePassService, type PassClaimResult } from "./battle-pass.service.js";
import { PASS_LANES, PASS_TIERS, type PassView } from "./pass-rules.js";

/**
 * Батл-пасс (`/api/v1/pass`, docs/35-stage4-plan.md Р46; tasks/T-0311): состояние
 * месяца и забор награды ступени. Только своё — аккаунт из токена; какая ступень
 * достигнута, решает сервер по очкам, VIP — по журналу периодов в момент запроса.
 * Награды в запросе нет: что выдать, знает лента месяца.
 */
const VIEW_LIMIT: RateLimit = { scope: "pass:view", limit: 600, windowSec: 3600 };
/** «Забрать всё» в оболочке идёт по одной награде: до 60 за раз (30 ступеней, две ленты), и повторы. */
const CLAIM_LIMIT: RateLimit = { scope: "pass:claim", limit: 600, windowSec: 3600 };

const claimSchema = z.object({ tier: z.number().int().min(1).max(PASS_TIERS), lane: z.enum(PASS_LANES) }).strict();

@Controller("pass")
@UseGuards(AuthGuard)
export class BattlePassController {
  constructor(
    private readonly pass: BattlePassService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: PassView }> {
    const account = accountOf(request);
    await this.limit(VIEW_LIMIT, account.accountId);
    return { data: await this.pass.view(account) };
  }

  @Post("claim")
  @HttpCode(200)
  async claim(@Req() request: unknown, @Body() body: unknown): Promise<{ data: PassClaimResult }> {
    const account = accountOf(request);
    const parsed = claimSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Нужны ступень от 1 до 30 и лента free или vip");
    await this.limit(CLAIM_LIMIT, account.accountId);
    return { data: await this.pass.claim(account, parsed.data.tier, parsed.data.lane) };
  }

  private async limit(limit: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
