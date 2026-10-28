import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { ValidationError } from "../../common/domain-error.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { uiClicksReport, uiScreensReport, type UiClickRow, type UiScreenRow } from "../funnel/ui-clicks-report.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { parse, periodOf } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { periodQuerySchema } from "./dto/admin.dto.js";

/**
 * Отчёт «Нажатия» в панели (docs/35-stage4-plan.md, Р141; tasks/T-0228): на
 * экране — какие кнопки нажимают и какая доля открывших её нажала. В ответе
 * только счётчики: идентификаторов игроков и устройств нет.
 */

/** Дольше трёх месяцев отчёт не режут: события по тексту payload читаются выборкой по периоду, а не по индексу экрана. */
const MAX_PERIOD_DAYS = 92;
const DAY_MS = 86_400_000;

const screensQuerySchema = periodQuerySchema.extend({ platform: z.enum(PLATFORM_IDS).optional() });
const clicksQuerySchema = screensQuerySchema.extend({ screen: z.string().trim().min(1).max(64) });

function periodOfReport(query: { from?: Date | undefined; to?: Date | undefined }): { from: Date; to: Date } {
  const period = periodOf(query, new Date());
  if (period.to.getTime() - period.from.getTime() > MAX_PERIOD_DAYS * DAY_MS) throw new ValidationError("Период не длиннее 92 дней");
  return period;
}

@Controller("admin")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminUiClicksController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Экраны, которые открывали за период, — по убыванию числа открывших. */
  @Get("ui-clicks/screens")
  @RequirePermission("analytics.gameplay.view")
  async screens(@Query() query: unknown): Promise<{ data: { from: string; to: string; screens: UiScreenRow[] } }> {
    const parsed = parse(() => screensQuerySchema.parse(query), "Некорректный период или площадка");
    const period = periodOfReport(parsed);
    const screens = await uiScreensReport(this.prisma, period.from, period.to, parsed.platform ?? null);
    return { data: { from: period.from.toISOString(), to: period.to.toISOString(), screens } };
  }

  /** Кнопки экрана: нажатий, игроков и доля открывших. */
  @Get("ui-clicks")
  @RequirePermission("analytics.gameplay.view")
  async clicks(@Query() query: unknown): Promise<{ data: { from: string; to: string; screen: string; opened: number; rows: UiClickRow[] } }> {
    const parsed = parse(() => clicksQuerySchema.parse(query), "Некорректный экран, период или площадка");
    const period = periodOfReport(parsed);
    const report = await uiClicksReport(this.prisma, { screen: parsed.screen, from: period.from, to: period.to, platform: parsed.platform ?? null });
    return { data: { from: period.from.toISOString(), to: period.to.toISOString(), screen: parsed.screen, opened: report.opened, rows: report.rows } };
  }
}
