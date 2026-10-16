import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PurchaseSupport, type SupportResult } from "../payments/purchase-support.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { accountIdSchema, purchaseIdSchema, purchaseSupportSchema } from "./dto/admin.dto.js";

/**
 * Поддержка покупок игрока в панели (tasks/T-0037): вернуть звёзды и
 * повторить выдачу. Контроллер только разбирает адрес и тело — право,
 * проверки, журнал и сообщение команде делает `PurchaseSupport`. Кнопки в
 * карточке игрока показываются по списку `actions` у покупки.
 */
@Controller("admin/players/:accountId/purchases")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPurchasesController {
  constructor(
    private readonly support: PurchaseSupport,
    private readonly limiter: RateLimiter,
  ) {}

  @Post(":purchaseId/refund")
  @HttpCode(200)
  @RequirePermission("payments.support")
  async refund(@Req() request: unknown, @Param("accountId") accountId: string, @Param("purchaseId") purchaseId: string, @Body() body: unknown): Promise<{ data: SupportResult }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const { note } = parse(() => purchaseSupportSchema.parse(body), NOTE_PROBLEM);
    return { data: await this.support.refund(actor, parseAccountId(accountId), parsePurchaseId(purchaseId), note) };
  }

  @Post(":purchaseId/fulfill")
  @HttpCode(200)
  @RequirePermission("payments.support")
  async fulfill(@Req() request: unknown, @Param("accountId") accountId: string, @Param("purchaseId") purchaseId: string, @Body() body: unknown): Promise<{ data: SupportResult }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const { note } = parse(() => purchaseSupportSchema.parse(body), NOTE_PROBLEM);
    return { data: await this.support.fulfill(actor, parseAccountId(accountId), parsePurchaseId(purchaseId), note) };
  }

  private async limit(actorId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actorId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}

const NOTE_PROBLEM = "Укажите причину: от 3 до 200 символов";

function parseAccountId(value: string): string {
  return parse(() => accountIdSchema.parse(value), "Некорректный идентификатор аккаунта");
}

function parsePurchaseId(value: string): string {
  return parse(() => purchaseIdSchema.parse(value), "Некорректный идентификатор покупки");
}
