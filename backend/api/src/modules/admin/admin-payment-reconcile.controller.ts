import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PaymentDiscrepancies } from "../payments/payment-discrepancies.js";
import { PaymentReconciler, type DiscrepancyView, type ReconcileOverview, type ReconcileSummary } from "../payments/payment-reconciler.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { purchaseSupportSchema } from "./dto/admin.dto.js";

/**
 * Сверка оплат с выпиской площадки в панели (Р209, WP53, tasks/T-0433, T-0434):
 * обзор — последняя сверка, открытые и недавно закрытые расхождения —,
 * кнопка «Сверить сейчас» и три действия по расхождению: «Повторить учёт»,
 * «Вернуть звёзды», «Разобрано». Контроллер только разбирает адрес и тело —
 * право, выключатель, лок, занятие расхождения и журнал делают
 * `PaymentReconciler` и `PaymentDiscrepancies`. Экран — T-0438.
 */
@Controller("admin/payment-reconcile")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPaymentReconcileController {
  constructor(
    private readonly reconciler: PaymentReconciler,
    private readonly discrepancies: PaymentDiscrepancies,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("payments.view")
  async overview(@Req() request: unknown): Promise<{ data: ReconcileOverview }> {
    return { data: await this.reconciler.overview(accountOf(request)) };
  }

  @Post("run")
  @HttpCode(200)
  @RequirePermission("payments.support")
  async run(@Req() request: unknown): Promise<{ data: ReconcileSummary[] }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.reconcile, actor.accountId))) throw new RateLimitedError("Слишком много сверок — подождите несколько минут");
    return { data: await this.reconciler.runNow(actor) };
  }

  @Post(":discrepancyId/retry")
  @HttpCode(200)
  @RequirePermission("payments.support")
  async retry(@Req() request: unknown, @Param("discrepancyId") discrepancyId: string, @Body() body: unknown): Promise<{ data: DiscrepancyView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    return { data: await this.discrepancies.retry(actor, idOf(discrepancyId), noteOf(body)) };
  }

  @Post(":discrepancyId/refund")
  @HttpCode(200)
  @RequirePermission("payments.support")
  async refund(@Req() request: unknown, @Param("discrepancyId") discrepancyId: string, @Body() body: unknown): Promise<{ data: DiscrepancyView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    return { data: await this.discrepancies.refund(actor, idOf(discrepancyId), noteOf(body)) };
  }

  @Post(":discrepancyId/dismiss")
  @HttpCode(200)
  @RequirePermission("payments.support")
  async dismiss(@Req() request: unknown, @Param("discrepancyId") discrepancyId: string, @Body() body: unknown): Promise<{ data: DiscrepancyView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    return { data: await this.discrepancies.dismiss(actor, idOf(discrepancyId), noteOf(body)) };
  }

  private async limit(actorId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actorId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}

/** Идентификатор расхождения — UUID: в базу идёт только он, адрес приходит от клиента. */
const discrepancyIdSchema = z.string().uuid();

function idOf(discrepancyId: string): string {
  return parse(() => discrepancyIdSchema.parse(discrepancyId), "Некорректный идентификатор расхождения");
}

function noteOf(body: unknown): string {
  return parse(() => purchaseSupportSchema.parse(body), "Укажите причину: от 3 до 200 символов").note;
}
