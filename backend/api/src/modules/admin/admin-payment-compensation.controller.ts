import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PurchaseCompensations, type CompensationPreview, type CompensationResult } from "../payments/purchase-compensation.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { purchaseIdSchema } from "./dto/admin.dto.js";

/**
 * Компенсация самоцветами за сбой оплаты в панели (docs/35-stage4-plan.md,
 * Р209, WP53, tasks/T-0435): предложение суммы и начисление из карточки
 * платежа. Контроллер только разбирает адрес и тело — право, правила, журнал
 * и сообщение команде делает `PurchaseCompensations`. Право — только владелец.
 *
 * Адрес `admin/payments/:purchaseId/…` не пересекается с карточкой платежа
 * (`GET admin/payments/:purchaseId`): у этих маршрутов лишний сегмент.
 */

/** Потолок суммы схемы — предел ключа `payments.compensation.max-gems`; настоящий потолок проверяет сервис. */
const SCHEMA_GEMS_MAX = 20_000;

export const compensateBodySchema = z.strictObject({
  gems: z.number().int().min(1).max(SCHEMA_GEMS_MAX),
  note: z.string().trim().min(3).max(200),
});

const BODY_PROBLEM = "Укажите сумму от 1 самоцвета и причину от 3 до 200 символов";

@Controller("admin/payments")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPaymentCompensationController {
  constructor(
    private readonly compensations: PurchaseCompensations,
    private readonly limiter: RateLimiter,
  ) {}

  @Get(":purchaseId/compensation")
  @RequirePermission("payments.compensate")
  async preview(@Req() request: unknown, @Param("purchaseId") purchaseId: string): Promise<{ data: CompensationPreview }> {
    return { data: await this.compensations.preview(accountOf(request), parsePurchaseId(purchaseId)) };
  }

  @Post(":purchaseId/compensate")
  @HttpCode(200)
  @RequirePermission("payments.compensate")
  async compensate(@Req() request: unknown, @Param("purchaseId") purchaseId: string, @Body() body: unknown): Promise<{ data: CompensationResult }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    const input = parse(() => compensateBodySchema.parse(body), BODY_PROBLEM);
    return { data: await this.compensations.compensate(actor, parsePurchaseId(purchaseId), input) };
  }
}

function parsePurchaseId(value: string): string {
  return parse(() => purchaseIdSchema.parse(value), "Некорректный идентификатор покупки");
}
