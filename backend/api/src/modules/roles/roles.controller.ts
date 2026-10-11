import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { permissionsOf, type Permission, type Role } from "./permissions.js";
import { RolesService } from "./roles.service.js";

/**
 * Свои роли и права — игроку и инструментам. Выдача ролей и журнал — только в
 * панели (`admin-roles.controller.ts`): у неё своя сессия с коротким сроком
 * (docs/29-admin-panel.md §3.4).
 */
@Controller("roles")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** Что может сам спрашивающий. Своё — всегда, права на это не нужно. */
  @Get("me")
  @UseGuards(AuthGuard)
  async me(@Req() request: unknown): Promise<{ data: { roles: Role[]; permissions: Permission[] } }> {
    const roles = await this.roles.rolesFor(accountOf(request));
    return { data: { roles, permissions: [...permissionsOf(roles)] } };
  }
}
