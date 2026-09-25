import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import type { AuditRecord } from "../roles/roles.repository.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminRolesService, type RoleAssignmentView } from "./admin-roles.service.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { auditLimitSchema, roleTargetSchema } from "./dto/admin.dto.js";

/** Роли и журнал аудита в панели (docs/29-admin-panel.md §3). */
@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminRolesController {
  constructor(
    private readonly roles: AdminRolesService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get("roles")
  @RequirePermission("roles.assign")
  async assignments(@Req() request: unknown): Promise<{ data: { assignments: RoleAssignmentView[] } }> {
    return { data: { assignments: await this.roles.assignments(accountOf(request)) } };
  }

  @Post("roles/grant")
  @RequirePermission("roles.assign")
  async grant(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { granted: boolean } }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    return { data: await this.roles.grant(actor, parse(() => roleTargetSchema.parse(body), "Некорректная цель")) };
  }

  @Post("roles/revoke")
  @RequirePermission("roles.assign")
  async revoke(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { revoked: boolean; sessionsRevoked: number } }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    return { data: await this.roles.revoke(actor, parse(() => roleTargetSchema.parse(body), "Некорректная цель")) };
  }

  @Get("audit")
  @RequirePermission("audit.view")
  async audit(@Req() request: unknown, @Query("limit") limit?: string): Promise<{ data: { entries: AuditRecord[] } }> {
    const parsed = parse(() => auditLimitSchema.parse(limit ?? undefined), "Некорректный предел");
    return { data: { entries: await this.roles.audit(accountOf(request), parsed) } };
  }

  private async limit(actorId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actorId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
