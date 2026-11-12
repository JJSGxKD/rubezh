import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { accountOf } from "../auth/auth.guard.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { AdminPulseService, type Pulse } from "./admin-pulse.service.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Пульс для шапки панели. Отдельного права нет: каждая часть проверяет своё,
 * у человека без прав все три приходят пустыми.
 */
@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPulseController {
  constructor(private readonly pulse: AdminPulseService) {}

  @Get("pulse")
  async get(@Req() request: unknown): Promise<{ data: Pulse }> {
    return { data: await this.pulse.pulse(accountOf(request)) };
  }
}
