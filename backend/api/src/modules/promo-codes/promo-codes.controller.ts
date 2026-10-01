import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { PromoCodeNotFoundError } from "./promo-code-errors.js";
import { PromoCodesService, type RedeemResult } from "./promo-codes.service.js";

/**
 * Ввод промокода игроком (`/api/v1/promo-codes`, docs/35-stage4-plan.md WP41).
 *
 * Лимит — против перебора кодов пачки: десять попыток за десять минут
 * хватает и на опечатки, и на пару кодов подряд, а на подбор кода из
 * миллиардов вариантов — нет. Удачные попытки считаются тоже: лимит
 * ставится до того, как известно, есть ли такой код.
 */
const LIMIT: RateLimit = { scope: "promo-codes", limit: 10, windowSec: 600 };
const bodySchema = z.object({ code: z.string().max(64) }).strict();

@Controller("promo-codes")
@UseGuards(AuthGuard)
export class PromoCodesController {
  constructor(
    private readonly promoCodes: PromoCodesService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post("redeem")
  @HttpCode(200)
  async redeem(@Req() request: unknown, @Body() body: unknown): Promise<{ data: RedeemResult }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(LIMIT, account.accountId))) throw new RateLimitedError("Слишком много попыток — попробуйте через несколько минут");
    const parsed = bodySchema.safeParse(body);
    // Неверное тело для игрока — тот же «такого кода нет»: подбирающему незачем знать формат.
    if (!parsed.success) throw new PromoCodeNotFoundError();
    return { data: await this.promoCodes.redeem(account, parsed.data.code) };
  }
}
