import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PaymentJobs } from "../payments/payment-jobs.js";
import { PaymentRetry } from "../payments/payment-retry.js";
import type { FailedPaymentJob } from "../payments/payments-queue.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { purchaseIdSchema, purchaseSupportSchema } from "./dto/admin.dto.js";

/**
 * Брошенные задания очереди оплаты и «Повторить учёт» в панели (Р209, WP53,
 * tasks/T-0431). Контроллер только разбирает адрес и тело — право, проверки,
 * журнал и сообщение команде делают `PaymentJobs` и `PaymentRetry`.
 *
 * Маршруты — под `admin/payment-jobs` и `POST admin/payments/:purchaseId/retry`,
 * а не под `GET admin/payments/jobs`: `GET admin/payments/:purchaseId` из ленты
 * платежей (`admin-payments.controller.ts`) перехватил бы такой адрес.
 */
@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPaymentJobsController {
  constructor(
    private readonly jobs: PaymentJobs,
    private readonly retry: PaymentRetry,
    private readonly limiter: RateLimiter,
  ) {}

  @Get("payment-jobs")
  @RequirePermission("payments.view")
  async list(@Req() request: unknown): Promise<{ data: { available: boolean; jobs: FailedPaymentJob[] } }> {
    return { data: await this.jobs.list(accountOf(request)) };
  }

  @Post("payment-jobs/:jobId/retry")
  @HttpCode(200)
  @RequirePermission("payments.support")
  async retryJob(@Req() request: unknown, @Param("jobId") jobId: string, @Body() body: unknown): Promise<{ data: { jobId: string; purchaseId: string | null } }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const id = parse(() => jobIdSchema.parse(jobId), "Некорректный идентификатор задания");
    const { note } = parse(() => purchaseSupportSchema.parse(body), NOTE_PROBLEM);
    return { data: await this.jobs.retryJob(actor, id, note) };
  }

  @Post("payments/:purchaseId/retry")
  @HttpCode(200)
  @RequirePermission("payments.support")
  async retryPayment(@Req() request: unknown, @Param("purchaseId") purchaseId: string, @Body() body: unknown): Promise<{ data: { retried: string[] } }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const id = parse(() => purchaseIdSchema.parse(purchaseId), "Некорректный идентификатор покупки");
    const { note } = parse(() => purchaseSupportSchema.parse(body), NOTE_PROBLEM);
    return { data: await this.retry.retry(actor, id, note) };
  }

  private async limit(actorId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actorId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}

const NOTE_PROBLEM = "Укажите причину: от 3 до 200 символов";

/** Идентификатор задания очереди: `confirm-<отпечаток>`, `refund-…`, `refunded-…` — строчные буквы, цифры и дефис. */
const jobIdSchema = z.string().regex(/^[a-z0-9-]{3,120}$/);
