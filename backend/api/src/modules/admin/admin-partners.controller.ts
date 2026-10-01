import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { partnerInputSchema } from "../partners/partner-rules.js";
import { PartnersService, type PartnerDetail, type PartnerView } from "../partners/partners.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Партнёры в панели (docs/35-stage4-plan.md WP41, часть 2; docs/29-admin-panel.md):
 * смотрят под `partners.view`, заводят и правят под `partners.edit`, каждое
 * изменение — в аудит. Удаления нет: по партнёру считаются его игроки.
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

  private async consume(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}

function partnerIdOf(raw: string): string {
  return parse(() => z.uuid().parse(raw), "Некорректный id партнёра");
}
