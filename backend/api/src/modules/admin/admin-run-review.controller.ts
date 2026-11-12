import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { RESTRICTION_LIMITS } from "../restrictions/restriction-catalog.js";
import { liftSchema } from "../restrictions/restriction-rules.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import type { AccountRef } from "../roles/roles.service.js";
import { RunReviewService, type RunReportView } from "../runs/run-review.service.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Отчёт забега и решения разбора в панели (Р203, tasks/T-0419): страница
 * отчёта читает `GET runs/:runId/report`, а «Честный», «Аннулировать» и
 * «Вернуть забег» отвечают тем же отчётом — после решения панель сразу видит
 * итог, без второго запроса. Что решения делают с досками и сезонами —
 * `run-review.service.ts`.
 *
 * Очередь `GET runs/review` живёт в `admin-review.controller.ts` и здесь не
 * повторяется: пути не пересекаются, у отчёта на сегмент больше.
 */

const runIdSchema = z.string().min(8).max(64);

/** Причина «Честного» необязательна: если задана — от 1 до 500 знаков, как у остальных решений. */
const honestSchema = z.strictObject({ comment: z.string().trim().min(1).max(RESTRICTION_LIMITS.commentMax).optional() });

@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminRunReviewController {
  constructor(
    private readonly review: RunReviewService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get("runs/:runId/report")
  @RequirePermission("players.view")
  async report(@Req() request: unknown, @Param("runId") runId: string): Promise<{ data: RunReportView }> {
    const id = parse(() => runIdSchema.parse(runId), "Некорректный идентификатор забега");
    return { data: await this.review.report(accountOf(request), id) };
  }

  @Post("runs/:runId/honest")
  @HttpCode(200)
  @RequirePermission("players.restrict")
  async honest(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: RunReportView }> {
    const actor = await this.actor(request);
    const id = parse(() => runIdSchema.parse(runId), "Некорректный идентификатор забега");
    // Тела может не быть вовсе: причина необязательна.
    const { comment } = parse(() => honestSchema.parse(body ?? {}), "Причина — от 1 до 500 знаков");
    return { data: await this.review.honest(actor, id, comment ?? null) };
  }

  @Post("runs/:runId/annul")
  @HttpCode(200)
  @RequirePermission("players.restrict")
  async annul(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: RunReportView }> {
    const actor = await this.actor(request);
    const id = parse(() => runIdSchema.parse(runId), "Некорректный идентификатор забега");
    const { comment } = parse(() => liftSchema.parse(body), "Нужна причина");
    return { data: await this.review.annul(actor, id, comment) };
  }

  @Post("runs/:runId/restore")
  @HttpCode(200)
  @RequirePermission("players.restrict")
  async restore(@Req() request: unknown, @Param("runId") runId: string, @Body() body: unknown): Promise<{ data: RunReportView }> {
    const actor = await this.actor(request);
    const id = parse(() => runIdSchema.parse(runId), "Некорректный идентификатор забега");
    const { comment } = parse(() => liftSchema.parse(body), "Нужна причина");
    return { data: await this.review.restore(actor, id, comment) };
  }

  /** Автор решения; решений в минуту не больше, чем у остальных изменяющих действий панели. */
  private async actor(request: unknown): Promise<AccountRef> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
