import { Body, Controller, Get, Param, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import type { StakeholdersView } from "../stakeholders/stakeholder-view.js";
import { StakeholdersService } from "../stakeholders/stakeholders.service.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

const accountIdSchema = z.uuid();

/**
 * Доля — число от 0 до 100; сколько знаков после запятой допустимо, решает сервис (`percentToBp`), потому что
 * схема не отличит 12,34 от 12,345 без тех же допусков. Причина обязательна: она остаётся в журнале.
 */
const shareSchema = z
  .object({
    sharePercent: z.number().min(0).max(100),
    fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    note: z.string().trim().min(3).max(500),
  })
  .strict();

/**
 * Доли участников проекта в панели (docs/35-stage4-plan.md Р217, tasks/T-0452). Охранник сессии пускает
 * любого с ролью, а **право проверяет сервис**, а не маршрут: смотреть список можно по `revenue.split.view` или
 * `revenue.split.own.view` (участник видит всех участников, но без причин), менять — только по
 * `stakeholders.manage` (оно же стоит на маршруте записи). Одно право на маршруте чтения не выразило бы
 * «или то, или другое».
 */
@Controller("admin/stakeholders")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminStakeholdersController {
  constructor(private readonly stakeholders: StakeholdersService) {}

  @Get()
  async list(@Req() request: unknown): Promise<{ data: StakeholdersView }> {
    return { data: await this.stakeholders.list(accountOf(request)) };
  }

  /**
   * Назначить долю с месяца; повтор того же запроса безопасен — запись на месяц заменяется тем же значением.
   * Право и на маршруте: чужой запрос получает отказ раньше разбора тела; сервис проверяет его и сам.
   */
  @Put(":accountId/share")
  @RequirePermission("stakeholders.manage")
  async setShare(@Req() request: unknown, @Param("accountId") accountId: string, @Body() body: unknown): Promise<{ data: StakeholdersView }> {
    const actor = accountOf(request);
    const id = parse(() => accountIdSchema.parse(accountId), "Некорректный идентификатор аккаунта");
    const share = parse(() => shareSchema.parse(body), "Доля — число от 0 до 100, месяц — ГГГГ-ММ, причина — от 3 до 500 знаков");
    return { data: await this.stakeholders.setShare(actor, id, share) };
  }
}
