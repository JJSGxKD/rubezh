import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import type { ShopInvoice } from "../payments/payments.service.js";
import { ShopService, type ShopView } from "./shop.service.js";
import { ShowcaseService, type ShowcaseBuyResult, type ShowcaseView } from "./showcase.service.js";

/**
 * Магазин (`/api/v1/shop`, docs/35-stage4-plan.md WP10): витрина и счёт на
 * товар. **Цены в запросе нет** — только какой товар: сколько он стоит,
 * решает сервер по каталогу. Состояние покупки клиент опрашивает там же,
 * где у второго шанса, — `GET /api/v1/payments/:purchaseId`.
 *
 * Витрина снаряжения — `GET /api/v1/shop/showcase` и покупка предложения за
 * самоцветы: цену берёт сервер из выставленного предложения.
 */
const VIEW_LIMIT: RateLimit = { scope: "shop:view", limit: 600, windowSec: 3600 };
/** Счёт — только по нажатию «Купить»: как у второго шанса. */
const ORDER_LIMIT: RateLimit = { scope: "shop:order", limit: 60, windowSec: 3600 };

/** Покупка с витрины — по нажатию: как счёт. */
const SHOWCASE_BUY_LIMIT: RateLimit = { scope: "shop:showcase_buy", limit: 60, windowSec: 3600 };

const orderSchema = z.object({ sku: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/) }).strict();
const offerIdSchema = z.uuid();

@Controller("shop")
@UseGuards(AuthGuard)
export class ShopController {
  constructor(
    private readonly shop: ShopService,
    private readonly showcase: ShowcaseService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: ShopView }> {
    const account = accountOf(request);
    await this.limit(VIEW_LIMIT, account.accountId);
    return { data: await this.shop.view(account) };
  }

  @Post("orders")
  @HttpCode(200)
  async order(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ShopInvoice }> {
    const account = accountOf(request);
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Некорректный товар");
    await this.limit(ORDER_LIMIT, account.accountId);
    return { data: await this.shop.order(account, parsed.data.sku) };
  }

  @Get("showcase")
  async showcaseView(@Req() request: unknown): Promise<{ data: ShowcaseView }> {
    const { accountId } = accountOf(request);
    await this.limit(VIEW_LIMIT, accountId);
    return { data: await this.showcase.view(accountId) };
  }

  @Post("showcase/:offerId/buy")
  @HttpCode(200)
  async showcaseBuy(@Req() request: unknown, @Param("offerId") offerId: string): Promise<{ data: ShowcaseBuyResult }> {
    const { accountId } = accountOf(request);
    if (!offerIdSchema.safeParse(offerId).success) throw new ValidationError("Некорректное предложение витрины");
    await this.limit(SHOWCASE_BUY_LIMIT, accountId);
    return { data: await this.showcase.buy(accountId, offerId) };
  }

  private async limit(limit: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
