import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { accountOf } from "../auth/auth.guard.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ProjectMonthService, type MyProjectView } from "../stakeholders/project-month.service.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Месяц `ГГГГ-ММ`; без него — текущий. Лишние поля запроса — ошибка. */
const querySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict();

/**
 * Кабинет «Мой проект» в панели (docs/35-stage4-plan.md Р218, tasks/T-0453). Охранник сессии пускает любого с
 * ролью, а **право проверяет сервис**: смотреть можно по `revenue.split.own.view` (участник; владелец тоже) или
 * `revenue.split.view` (финансы) — одно право на маршруте не выразило бы «или то, или другое». Только чтение.
 */
@Controller("admin/my-project")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminMyProjectController {
  constructor(private readonly project: ProjectMonthService) {}

  @Get()
  async month(@Req() request: unknown, @Query() query: unknown): Promise<{ data: MyProjectView }> {
    const { month } = parse(() => querySchema.parse(query), "Месяц — в виде ГГГГ-ММ");
    return { data: await this.project.month(accountOf(request), month) };
  }
}
