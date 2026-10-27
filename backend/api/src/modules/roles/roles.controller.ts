import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { permissionsOf, type Permission, type Role } from "./permissions.js";
import { ROLES_LIMITS } from "./roles-limits.js";
import { RolesService } from "./roles.service.js";

/**
 * Свои роли и права — игроку и инструментам. Выдача ролей и журнал — только в
 * панели (`admin-roles.controller.ts`): у неё своя сессия с коротким сроком
 * (docs/29-admin-panel.md §3.4).
 */
@Controller("roles")
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Что может сам спрашивающий. Своё — всегда, права на это не нужно. */
  @Get("me")
  @UseGuards(AuthGuard)
  async me(@Req() request: unknown): Promise<{ data: { roles: Role[]; permissions: Permission[] } }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(ROLES_LIMITS.me, account.accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
    const roles = await this.roles.rolesFor(account);
    return { data: { roles, permissions: [...permissionsOf(roles)] } };
  }
}
