import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { promoCampaignInputSchema, promoCampaignUpdateSchema } from "../promo-codes/promo-code-rules.js";
import { PromoCodesService, type CodeCheck, type PromoCampaignDetail, type PromoCampaignView, type PromoCatalogView } from "../promo-codes/promo-codes.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Промокоды в панели (docs/35-stage4-plan.md WP41, docs/29-admin-panel.md):
 * общий код или пачка одноразовых, награда, срок, лимит и кому — под
 * `promo.edit`, каждое действие — в аудит. Код и вид после заведения не
 * меняются: напечатанный в посте код обязан вести туда же.
 */
@Controller("admin/promo-codes")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPromoCodesController {
  constructor(
    private readonly promoCodes: PromoCodesService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("promo.edit")
  async list(@Req() request: unknown): Promise<{ data: PromoCatalogView }> {
    return { data: await this.promoCodes.catalog(accountOf(request)) };
  }

  /** Свободен ли код — мастер спрашивает, пока его набирают. */
  @Get("check")
  @RequirePermission("promo.edit")
  async check(@Req() request: unknown, @Query("code") code: unknown): Promise<{ data: CodeCheck }> {
    const raw = parse(() => z.string().max(48).parse(code), "Некорректный код");
    return { data: await this.promoCodes.check(accountOf(request), raw) };
  }

  @Get(":campaignId")
  @RequirePermission("promo.edit")
  async detail(@Req() request: unknown, @Param("campaignId") campaignId: string): Promise<{ data: PromoCampaignDetail }> {
    return { data: await this.promoCodes.detail(accountOf(request), campaignIdOf(campaignId)) };
  }

  @Post()
  @RequirePermission("promo.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: PromoCampaignView }> {
    const actor = await this.consume(request);
    const input = parse(() => promoCampaignInputSchema.parse(body), "Некорректный промокод");
    return { data: await this.promoCodes.create(actor, input) };
  }

  @Post(":campaignId")
  @RequirePermission("promo.edit")
  async update(@Req() request: unknown, @Param("campaignId") campaignId: string, @Body() body: unknown): Promise<{ data: PromoCampaignView }> {
    const actor = await this.consume(request);
    const update = parse(() => promoCampaignUpdateSchema.parse(body), "Некорректный промокод");
    return { data: await this.promoCodes.update(actor, campaignIdOf(campaignId), update) };
  }

  @Post(":campaignId/pause")
  @RequirePermission("promo.edit")
  async pause(@Req() request: unknown, @Param("campaignId") campaignId: string): Promise<{ data: PromoCampaignView }> {
    const actor = await this.consume(request);
    return { data: await this.promoCodes.pause(actor, campaignIdOf(campaignId), true) };
  }

  @Post(":campaignId/resume")
  @RequirePermission("promo.edit")
  async resume(@Req() request: unknown, @Param("campaignId") campaignId: string): Promise<{ data: PromoCampaignView }> {
    const actor = await this.consume(request);
    return { data: await this.promoCodes.pause(actor, campaignIdOf(campaignId), false) };
  }

  @Post(":campaignId/remove")
  @RequirePermission("promo.edit")
  async remove(@Req() request: unknown, @Param("campaignId") campaignId: string): Promise<{ data: { removed: true } }> {
    const actor = await this.consume(request);
    await this.promoCodes.remove(actor, campaignIdOf(campaignId));
    return { data: { removed: true } };
  }

  private async consume(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}

function campaignIdOf(raw: string): string {
  return parse(() => z.uuid().parse(raw), "Некорректный id промокода");
}
