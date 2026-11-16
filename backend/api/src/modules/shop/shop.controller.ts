import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import type { ShopInvoice } from "../payments/payments.service.js";
import { FreeGemsService, type FreeGemsResult, type FreeGemsView } from "./free-gems.service.js";
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
 *
 * Самоцветы за ролик (Р155, T-0243): состояние карточки — поле `freeGems`
 * витрины, взятие — `POST /api/v1/shop/free-gems` с сессией показа места
 * `free_gems`. Сколько самоцветов, решает сервер по ключу панели.
 */
const VIEW_LIMIT: RateLimit = { scope: "shop:view", limit: 600, windowSec: 3600 };
/** Счёт — только по нажатию «Купить»: как у второго шанса. */
const ORDER_LIMIT: RateLimit = { scope: "shop:order", limit: 60, windowSec: 3600 };

/** Покупка с витрины — по нажатию: как счёт. */
const SHOWCASE_BUY_LIMIT: RateLimit = { scope: "shop:showcase_buy", limit: 60, windowSec: 3600 };

const orderSchema = z.object({ sku: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/) }).strict();
const offerIdSchema = z.uuid();

/** Идентификатор сессии показа — как его выдаёт модуль рекламы (`ads.controller.ts`). */
const freeGemsSchema = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{16}$/) }).strict();

@Controller("shop")
@UseGuards(AuthGuard)
export class ShopController {
  constructor(
    private readonly shop: ShopService,
    private readonly showcase: ShowcaseService,
    private readonly freeGems: FreeGemsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: ShopView & { freeGems: FreeGemsView } }> {
    const account = accountOf(request);
    await this.limit(VIEW_LIMIT, account.accountId);
    const [view, freeGems] = await Promise.all([this.shop.view(account), this.freeGems.view(account)]);
    return { data: { ...view, freeGems } };
  }

  /** Самоцветы за ролик: взятие по досмотренной сессии показа. Лимит — как у покупок: по нажатию. */
  @Post("free-gems")
  @HttpCode(200)
  async claimFreeGems(@Req() request: unknown, @Body() body: unknown): Promise<{ data: FreeGemsResult }> {
    const account = accountOf(request);
    const parsed = freeGemsSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Некорректный показ");
    await this.limit(ORDER_LIMIT, account.accountId);
    return { data: await this.freeGems.claim(account, parsed.data.sessionId) };
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
    if (!(await this.limiter.consume(limit, accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
  }
}
