import { Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PaymentReconciler, type ReconcileOverview, type ReconcileSummary } from "../payments/payment-reconciler.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Сверка оплат с выпиской площадки в панели (Р209, WP53, tasks/T-0433):
 * обзор — последняя сверка, открытые и недавно закрытые расхождения — и
 * кнопка «Сверить сейчас». Контроллер только принимает запрос — право,
 * выключатель, лок и журнал делает `PaymentReconciler`. Действия по
 * расхождениям — T-0434, экран — T-0438.
 */
@Controller("admin/payment-reconcile")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPaymentReconcileController {
  constructor(
    private readonly reconciler: PaymentReconciler,
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
}
