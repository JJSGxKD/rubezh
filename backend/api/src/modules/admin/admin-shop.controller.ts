import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { promoInputSchema } from "../shop/shop-promo-rules.js";
import { ShopPromoService, type PromoAdminRow, type PromoCatalogView } from "../shop/shop-promo.service.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Акции магазина в панели (docs/35-stage4-plan.md WP10, часть 8): скидка от
 * цены каталога на срок — под `shop.promo.edit`, каждое действие — в аудит.
 * Правки нет: акцию снимают и заводят заново — иначе игрок увидел бы, как
 * «прежняя» цена или срок меняются на ходу.
 */
@Controller("admin/shop/promos")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminShopController {
  constructor(
    private readonly promos: ShopPromoService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("shop.promo.edit")
  async list(@Req() request: unknown): Promise<{ data: PromoCatalogView }> {
    return { data: await this.promos.catalog(accountOf(request)) };
  }

  @Post()
  @RequirePermission("shop.promo.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: PromoAdminRow }> {
    const actor = await this.consume(request);
    const input = parse(() => promoInputSchema.parse(body), "Некорректная акция");
    return { data: await this.promos.create(actor, input) };
  }

  @Post(":promoId/cancel")
  @RequirePermission("shop.promo.edit")
  async cancel(@Req() request: unknown, @Param("promoId") promoId: string): Promise<{ data: PromoAdminRow }> {
    const actor = await this.consume(request);
    const id = parse(() => z.uuid().parse(promoId), "Некорректный id акции");
    return { data: await this.promos.cancel(actor, id) };
  }

  private async consume(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
