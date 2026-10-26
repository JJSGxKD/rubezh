import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import type { ShopInvoice } from "../payments/payments.service.js";
import { DonationsService, type DonationView } from "./donations.service.js";

/**
 * Донаты проекту (`/api/v1/donations`, docs/35-stage4-plan.md, Р109): что
 * показать на листе доната и счёт на сумму. Сумму называет игрок, но пределы
 * знает сервер: тело — только число звёзд. Состояние покупки клиент опрашивает
 * там же, где у магазина, — `GET /api/v1/payments/:purchaseId`.
 */
const VIEW_LIMIT: RateLimit = { scope: "donations:view", limit: 600, windowSec: 3600 };
/** Счёт — только по нажатию «Поддержать»: как заказ в магазине, но реже: донат — не повседневная покупка. */
const ORDER_LIMIT: RateLimit = { scope: "donations:order", limit: 30, windowSec: 3600 };

const orderSchema = z.object({ amount: z.number().int() }).strict();

@Controller("donations")
@UseGuards(AuthGuard)
export class DonationsController {
  constructor(
    private readonly donations: DonationsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: DonationView }> {
    const account = accountOf(request);
    await this.limit(VIEW_LIMIT, account.accountId);
    return { data: await this.donations.view(account) };
  }

  @Post("orders")
  @HttpCode(200)
  async order(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ShopInvoice }> {
    const account = accountOf(request);
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Некорректная сумма");
    await this.limit(ORDER_LIMIT, account.accountId);
    return { data: await this.donations.order(account, parsed.data.amount) };
  }

  private async limit(limit: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
