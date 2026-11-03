import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PARTNER_STATUSES, partnerInputSchema } from "../partners/partner-rules.js";
import { PartnersService, type PartnerDetail, type PartnerFunnel, type PartnerView } from "../partners/partners.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { periodQuerySchema } from "./dto/admin.dto.js";
import { parse, periodOf } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Смена статуса: сам статус и причина; длину причины проверяет сервис — одна проверка на все пути. */
const statusSchema = z.object({ status: z.enum(PARTNER_STATUSES), reason: z.string().max(1_000) }).strict();

/**
 * Партнёры в панели (docs/35-stage4-plan.md WP41, часть 2; docs/29-admin-panel.md):
 * смотрят под `partners.view`, заводят и правят под `partners.edit`, каждое
 * изменение — в аудит. Удаления нет: по партнёру считаются его игроки.
 * Статус партнёра меняется отдельной ручкой, с причиной.
 */
@Controller("admin/partners")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPartnersController {
  constructor(
    private readonly partners: PartnersService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("partners.view")
  async list(@Req() request: unknown): Promise<{ data: Awaited<ReturnType<PartnersService["catalog"]>> }> {
    return { data: await this.partners.catalog(accountOf(request)) };
  }

  @Get(":partnerId")
  @RequirePermission("partners.view")
  async detail(@Req() request: unknown, @Param("partnerId") partnerId: string): Promise<{ data: PartnerDetail }> {
    return { data: await this.partners.detail(accountOf(request), partnerIdOf(partnerId)) };
  }

  /** Воронка игроков партнёра за период (по дате привязки); умолчание — тридцать суток. */
  @Get(":partnerId/funnel")
  @RequirePermission("partners.view")
  async funnel(@Req() request: unknown, @Param("partnerId") partnerId: string, @Query() query: unknown): Promise<{ data: PartnerFunnel }> {
    const period = periodOf(parse(() => periodQuerySchema.parse(query), "Некорректный период"), new Date());
    return { data: await this.partners.funnel(accountOf(request), partnerIdOf(partnerId), period.from, period.to) };
  }

  @Post()
  @RequirePermission("partners.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: PartnerView }> {
    const actor = await this.consume(request);
    const input = parse(() => partnerInputSchema.parse(body), "Некорректный партнёр");
    return { data: await this.partners.create(actor, input) };
  }

  @Post(":partnerId")
  @RequirePermission("partners.edit")
  async update(@Req() request: unknown, @Param("partnerId") partnerId: string, @Body() body: unknown): Promise<{ data: PartnerView }> {
    const actor = await this.consume(request);
    const input = parse(() => partnerInputSchema.parse(body), "Некорректный партнёр");
    return { data: await this.partners.update(actor, partnerIdOf(partnerId), input) };
  }

  @Put(":partnerId/status")
  @RequirePermission("partners.edit")
  async setStatus(@Req() request: unknown, @Param("partnerId") partnerId: string, @Body() body: unknown): Promise<{ data: PartnerView }> {
    const actor = await this.consume(request);
    const { status, reason } = parse(() => statusSchema.parse(body), "Нужны статус — заявка, активен, приостановлен или отклонён — и причина");
    return { data: await this.partners.setStatus(actor, partnerIdOf(partnerId), status, reason) };
  }

  private async consume(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}

function partnerIdOf(raw: string): string {
  return parse(() => z.uuid().parse(raw), "Некорректный id партнёра");
}
