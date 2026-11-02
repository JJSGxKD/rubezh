import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { AdminAllTimeService, type AllTime } from "./admin-all-time.service.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Итоги за всё время для панели «Чего достигли» на экране «Сводка»
 * (tasks/T-0203). Отдельный маршрут, а не часть `GET /admin/overview`: сводка
 * обновляется раз в минуту, а эти агрегаты тяжёлые и живут в кеше пять минут.
 * Лимита частоты нет — как у остальных чтений панели: ответ кеширован, база
 * под ним не дёргается чаще раза в пять минут.
 */
@Controller("admin/overview")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminAllTimeController {
  constructor(private readonly allTime: AdminAllTimeService) {}

  @Get("all-time")
  @RequirePermission("analytics.gameplay.view")
  async get(@Req() request: unknown): Promise<{ data: AllTime }> {
    return { data: await this.allTime.allTime(accountOf(request)) };
  }
}
