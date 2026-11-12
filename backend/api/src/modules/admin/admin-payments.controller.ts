import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import { PaymentsFeed, type FeedPage, type PaymentCard } from "../payments/payments-feed.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { purchaseIdSchema } from "./dto/admin.dto.js";
import { feedFiltersOf, paymentsFeedQuerySchema } from "./dto/admin-payments.dto.js";

/**
 * Лента платежей и карточка платежа в панели (Р209, WP53, tasks/T-0429):
 * только чтение. Контроллер разбирает запрос и адрес — право, отбор,
 * хронологию и действия по праву актёра делает `PaymentsFeed`.
 *
 * Других маршрутов `GET admin/payments/*` в панели быть не должно: `:purchaseId`
 * перехватит их. Брошенные задания и сверка живут под `admin/payment-jobs` и
 * `admin/payment-reconcile`.
 */
@Controller("admin/payments")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPaymentsController {
  constructor(private readonly feed: PaymentsFeed) {}

  @Get()
  @RequirePermission("payments.view")
  async list(@Req() request: unknown, @Query() query: unknown): Promise<{ data: FeedPage }> {
    const parsed = parse(() => paymentsFeedQuerySchema.parse(query), "Неверный фильтр ленты платежей");
    return { data: await this.feed.page(accountOf(request), feedFiltersOf(parsed), parsed.cursor ?? null, parsed.limit) };
  }

  @Get(":purchaseId")
  @RequirePermission("payments.view")
  async card(@Req() request: unknown, @Param("purchaseId") purchaseId: string): Promise<{ data: PaymentCard }> {
    const id = parse(() => purchaseIdSchema.parse(purchaseId), "Некорректный идентификатор покупки");
    return { data: await this.feed.card(accountOf(request), id) };
  }
}
