import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import type { RecleanState } from "../name-rules/name-rules-reclean-state.js";
import { NameRulesRecleanService } from "../name-rules/name-rules-reclean.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Перечистка ников из панели (docs/35-stage4-plan.md, Р168, tasks/T-0339):
 * состояние, предпросмотр, запуск и остановка. Право одно — `names.edit`.
 * Запуск принимает только `previewRunId` готового предпросмотра: сервис сверяет
 * его, срок и подпись правил.
 */
const runSchema = z.strictObject({ previewRunId: z.string().uuid() });

@Controller("admin/name-rules/reclean")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminNameRulesRecleanController {
  constructor(
    private readonly reclean: NameRulesRecleanService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("names.edit")
  async state(@Req() request: unknown): Promise<{ data: RecleanState | null }> {
    return { data: await this.reclean.state(accountOf(request)) };
  }

  @Post("preview")
  @HttpCode(200)
  @RequirePermission("names.edit")
  async preview(@Req() request: unknown): Promise<{ data: RecleanState }> {
    return { data: await this.reclean.startPreview(await this.mutating(request)) };
  }

  @Post("run")
  @HttpCode(200)
  @RequirePermission("names.edit")
  async run(@Req() request: unknown, @Body() body: unknown): Promise<{ data: RecleanState }> {
    const actor = await this.mutating(request);
    return { data: await this.reclean.startRun(actor, parse(() => runSchema.parse(body), "Некорректный предпросмотр")) };
  }

  @Post("stop")
  @HttpCode(200)
  @RequirePermission("names.edit")
  async stop(@Req() request: unknown): Promise<{ data: RecleanState | null }> {
    return { data: await this.reclean.stop(await this.mutating(request)) };
  }

  private async mutating(request: unknown): Promise<ReturnType<typeof accountOf>> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
