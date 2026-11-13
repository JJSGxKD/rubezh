import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import type { ChangeOverview, ChangeRequestView } from "../change-requests/change-request-types.js";
import { ChangeRequestsService } from "../change-requests/change-requests.service.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Заявки на правку цен в панели (docs/19-content-admin.md §6, tasks/T-0309):
 * один предлагает «было → стало» с причиной, другой с тем же правом
 * подтверждает. Читать — `sku.price.view`, подавать и решать — `sku.price.edit`;
 * что автор не решает свою заявку, а подтверждение и применение — одна
 * транзакция, держит сервис. Каждое действие — в аудит.
 */

const idSchema = z.string().uuid();

@Controller("admin/change-requests")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminChangeRequestsController {
  constructor(
    private readonly requests: ChangeRequestsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("sku.price.view")
  async overview(@Req() request: unknown): Promise<{ data: ChangeOverview }> {
    return { data: await this.requests.overview(accountOf(request)) };
  }

  @Post()
  @RequirePermission("sku.price.edit")
  async propose(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ChangeRequestView }> {
    const actor = await this.consume(request);
    return { data: await this.requests.propose(actor, body) };
  }

  @Post(":requestId/approve")
  @RequirePermission("sku.price.edit")
  async approve(@Req() request: unknown, @Param("requestId") requestId: string): Promise<{ data: ChangeRequestView }> {
    const actor = await this.consume(request);
    return { data: await this.requests.approve(actor, this.id(requestId)) };
  }

  @Post(":requestId/reject")
  @RequirePermission("sku.price.edit")
  async reject(@Req() request: unknown, @Param("requestId") requestId: string): Promise<{ data: ChangeRequestView }> {
    const actor = await this.consume(request);
    return { data: await this.requests.reject(actor, this.id(requestId)) };
  }

  @Post(":requestId/withdraw")
  @RequirePermission("sku.price.edit")
  async withdraw(@Req() request: unknown, @Param("requestId") requestId: string): Promise<{ data: ChangeRequestView }> {
    const actor = await this.consume(request);
    return { data: await this.requests.withdraw(actor, this.id(requestId)) };
  }

  private id(value: string): string {
    return parse(() => idSchema.parse(value), "Некорректный идентификатор заявки");
  }

  private async consume(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
