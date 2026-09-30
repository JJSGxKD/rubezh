import { Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import type { ShopInvoice } from "../payments/payments.service.js";
import { VipService, type VipDailyResult, type VipView } from "./vip.service.js";

/**
 * VIP (`/api/v1/vip`, docs/35-stage4-plan.md WP10): состояние, счёт на
 * подписку, отмена и возврат продления, самоцветы дня. **Цены в запросе нет**:
 * сколько стоит период, решает сервер. Состояние покупки клиент опрашивает
 * там же, где у магазина, — `GET /api/v1/payments/:purchaseId`.
 */
const VIEW_LIMIT: RateLimit = { scope: "vip:view", limit: 600, windowSec: 3600 };
/** Счёт — только по нажатию «Оформить»: как у магазина. */
const ORDER_LIMIT: RateLimit = { scope: "vip:order", limit: 60, windowSec: 3600 };
/** Отмена и возврат продления ходят в площадку — реже всего остального. */
const RENEWAL_LIMIT: RateLimit = { scope: "vip:renewal", limit: 30, windowSec: 3600 };
const DAILY_LIMIT: RateLimit = { scope: "vip:daily", limit: 60, windowSec: 3600 };

@Controller("vip")
@UseGuards(AuthGuard)
export class VipController {
  constructor(
    private readonly vip: VipService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: VipView }> {
    const account = accountOf(request);
    await this.limit(VIEW_LIMIT, account.accountId);
    return { data: await this.vip.view(account) };
  }

  @Post("orders")
  @HttpCode(200)
  async order(@Req() request: unknown): Promise<{ data: ShopInvoice }> {
    const account = accountOf(request);
    await this.limit(ORDER_LIMIT, account.accountId);
    return { data: await this.vip.order(account) };
  }

  @Post("cancel")
  @HttpCode(200)
  async cancel(@Req() request: unknown): Promise<{ data: VipView }> {
    const account = accountOf(request);
    await this.limit(RENEWAL_LIMIT, account.accountId);
    return { data: await this.vip.cancel(account) };
  }

  @Post("resume")
  @HttpCode(200)
  async resume(@Req() request: unknown): Promise<{ data: VipView }> {
    const account = accountOf(request);
    await this.limit(RENEWAL_LIMIT, account.accountId);
    return { data: await this.vip.resume(account) };
  }

  @Post("daily")
  @HttpCode(200)
  async daily(@Req() request: unknown): Promise<{ data: VipDailyResult }> {
    const account = accountOf(request);
    await this.limit(DAILY_LIMIT, account.accountId);
    return { data: await this.vip.claimDaily(account) };
  }

  private async limit(limit: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
