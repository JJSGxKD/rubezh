import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { accountOf } from "../auth/auth.guard.js";
import { TrafficService, type TrafficReport } from "../proxies/subscription/traffic/traffic.service.js";
import { TRAFFIC_PERIODS } from "../proxies/subscription/traffic/traffic-rules.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Трафик через узлы Xray в панели (docs/29-admin-panel.md, раздел «Прокси»;
 * docs/35-stage4-plan.md Р192, tasks/T-0386). Только чтение: смотреть —
 * `proxies.view`. Период — `day`, `week` или `month`, по умолчанию `day`; другое —
 * 400 до обращения к базе.
 */
const querySchema = z.object({ period: z.enum(TRAFFIC_PERIODS).default("day") });

const BAD_PERIOD = "Некорректный период: day, week или month";

@Controller("admin/proxy-traffic")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminProxyTrafficController {
  constructor(private readonly traffic: TrafficService) {}

  @Get()
  @RequirePermission("proxies.view")
  async report(@Req() request: unknown, @Query() query: unknown): Promise<{ data: TrafficReport }> {
    const { period } = parse(() => querySchema.parse(query ?? {}), BAD_PERIOD);
    return { data: await this.traffic.report(accountOf(request), period) };
  }
}
