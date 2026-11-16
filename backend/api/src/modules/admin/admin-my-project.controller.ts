import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import type { MyReportView } from "../ledger/payouts/payout-view.js";
import { PayoutsService } from "../ledger/payouts/payouts.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ProjectMonthService, type MyProjectView } from "../stakeholders/project-month.service.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Месяц `ГГГГ-ММ`; без него — текущий. Лишние поля запроса — ошибка. */
const querySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict();

/** Месяц отчёта в адресе и решение участника: комментарий спору обязателен, его длину проверяет сервис. */
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const confirmSchema = z.strictObject({ decision: z.enum(["confirmed", "disputed"]), comment: z.string().optional() });

/**
 * Кабинет «Мой проект» в панели (docs/35-stage4-plan.md Р218, tasks/T-0453). Охранник сессии пускает любого с
 * ролью, а **право проверяет сервис**: смотреть можно по `revenue.split.own.view` (участник; владелец тоже) или
 * `revenue.split.view` (финансы) — одно право на маршруте не выразило бы «или то, или другое». Месяц проекта — только чтение.
 *
 * Отчёт закрытого месяца и его подтверждение (Р222, tasks/T-0469): участник читает свой отчёт и подтверждает или
 * оспаривает его; охранник сессии пускает любого с ролью, а «свой ли месяц» и право «свой расчёт» проверяет
 * `PayoutsService`: чужой месяц — 403, не закрытый — 409.
 */
@Controller("admin/my-project")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminMyProjectController {
  constructor(
    private readonly project: ProjectMonthService,
    private readonly payouts: PayoutsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async month(@Req() request: unknown, @Query() query: unknown): Promise<{ data: MyProjectView }> {
    const { month } = parse(() => querySchema.parse(query), "Месяц — в виде ГГГГ-ММ");
    return { data: await this.project.month(accountOf(request), month) };
  }

  /** Свой отчёт закрытого месяца: водопад из снимка, своя строка и решение. */
  @Get("periods/:period")
  async periodReport(@Req() request: unknown, @Param("period") period: string): Promise<{ data: MyReportView }> {
    return { data: await this.payouts.reportFor(accountOf(request), parse(() => periodSchema.parse(period), "Месяц — в виде ГГГГ-ММ")) };
  }

  /** Подтвердить или оспорить свой отчёт: пока участнику не выплачено, решение можно поменять. */
  @Post("periods/:period/confirm")
  @HttpCode(200)
  async confirmPeriod(@Req() request: unknown, @Param("period") period: string, @Body() body: unknown): Promise<{ data: MyReportView }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подожди минуту");
    const month = parse(() => periodSchema.parse(period), "Месяц — в виде ГГГГ-ММ");
    const input = parse(() => confirmSchema.parse(body), "Некорректное решение: нужно поле decision — confirmed или disputed и, по желанию, строка comment");
    return { data: await this.payouts.confirm(actor, month, input) };
  }
}
