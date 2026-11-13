import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { XrayCoreService, type XrayCoreView } from "../proxies/xray-core/xray-core.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * «Ядро Xray» в панели (docs/35-stage4-plan.md Р202, tasks/T-0416): состояние,
 * «проверить выпуск сейчас» и «обновить». Смотреть — `proxies.view`, остальное —
 * `proxies.edit`. Схема тела держит только форму версии; вправе ли владелец
 * запускать именно её, решает сервис.
 */

const updateSchema = z.strictObject({ version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/) });
const BAD_VERSION = "Некорректная версия";

@Controller("admin/xray-core")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminXrayCoreController {
  constructor(
    private readonly core: XrayCoreService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("proxies.view")
  async state(@Req() request: unknown): Promise<{ data: XrayCoreView }> {
    return { data: await this.core.view(accountOf(request)) };
  }

  @Post("refresh")
  @HttpCode(200)
  @RequirePermission("proxies.edit")
  async refresh(@Req() request: unknown): Promise<{ data: XrayCoreView }> {
    return { data: await this.core.refresh(await this.mutating(request)) };
  }

  @Post("update")
  @HttpCode(200)
  @RequirePermission("proxies.edit")
  async update(@Req() request: unknown, @Body() body: unknown): Promise<{ data: XrayCoreView }> {
    const actor = await this.mutating(request);
    const input = parse(() => updateSchema.parse(body), BAD_VERSION);
    return { data: await this.core.update(actor, input.version) };
  }

  private async mutating(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
