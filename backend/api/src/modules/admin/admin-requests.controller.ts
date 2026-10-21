import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { REQUEST_PERIODS, RequestJournalService, type InboundReport, type OutboundPage, type OutboundSummary, type RequestPeriod } from "../request-journal/request-journal.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Период: пусто — сутки; чужое значение — 400, а не молчаливые сутки. */
const periodSchema = z.object({ period: z.enum(REQUEST_PERIODS).default("day") });

/** Вызовы: служба — метка клиента исходящих (колонка на 32 знака), курсор — `id` строки, «только ошибки» — `errors=1`. */
const callsSchema = z.object({
  service: z.string().min(1).max(32).optional(),
  errors: z.literal("1").optional(),
  before: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});

const PERIOD_MESSAGE = "Период — час, сутки или неделя";

/**
 * Раздел «Запросы» панели (docs/35-stage4-plan.md Р92, tasks/T-0061):
 * исходящие вызовы сервера и сводка входящих по маршрутам. Только чтение —
 * журнал пишет модуль `request-journal`, а в нём нет ни игроков, ни адресов
 * с query, поэтому отдельного права на персональные данные не нужно.
 */
@Controller("admin/requests")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminRequestsController {
  constructor(private readonly journal: RequestJournalService) {}

  @Get("outbound/summary")
  @RequirePermission("requests.view")
  async outboundSummary(@Query() query: unknown): Promise<{ data: OutboundSummary }> {
    return { data: await this.journal.outboundSummary(periodOf(query)) };
  }

  @Get("outbound")
  @RequirePermission("requests.view")
  async outbound(@Query() query: unknown): Promise<{ data: OutboundPage }> {
    const period = periodOf(query);
    const filter = parse(() => callsSchema.parse(query), "Некорректные параметры списка вызовов");
    return { data: await this.journal.outboundCalls(period, { service: filter.service ?? null, onlyErrors: filter.errors === "1", before: filter.before ?? null }) };
  }

  @Get("inbound")
  @RequirePermission("requests.view")
  async inbound(@Query() query: unknown): Promise<{ data: InboundReport }> {
    return { data: await this.journal.inbound(periodOf(query)) };
  }
}

function periodOf(query: unknown): RequestPeriod {
  return parse(() => periodSchema.parse(query), PERIOD_MESSAGE).period;
}
