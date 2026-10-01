import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { FUNNEL_DAYS, AdsCatalogService, blockEditSchema, networkEditSchema, type AdNetworkView, type AdsCatalogView } from "../ads/ads-catalog.service.js";
import type { AdBlockDef } from "../ads/ads-catalog.repository.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Реклама в панели (docs/29-admin-panel.md, WP12): сети — включить и
 * поставить в круг, блоки мест — завести и править, воронка показов по
 * сетям и местам за сутки, неделю или месяц.
 */
const viewQuerySchema = z.object({ days: z.coerce.number().pipe(z.union(FUNNEL_DAYS.map((days) => z.literal(days)))).optional() });

@Controller("admin/ads")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminAdsController {
  constructor(
    private readonly catalog: AdsCatalogService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("ads.view")
  async view(@Req() request: unknown, @Query() query: unknown): Promise<{ data: AdsCatalogView }> {
    const { days } = parse(() => viewQuerySchema.parse(query), "Окно воронки — сутки, неделя или месяц");
    return { data: await this.catalog.view(accountOf(request), days ?? 7) };
  }

  @Post("networks")
  @RequirePermission("ads.edit")
  async saveNetwork(@Req() request: unknown, @Body() body: unknown): Promise<{ data: AdNetworkView }> {
    const actor = await this.mutating(request);
    return { data: await this.catalog.saveNetwork(actor, parse(() => networkEditSchema.parse(body), "Некорректная сеть")) };
  }

  @Post("blocks")
  @RequirePermission("ads.edit")
  async saveBlock(@Req() request: unknown, @Body() body: unknown): Promise<{ data: AdBlockDef }> {
    const actor = await this.mutating(request);
    return { data: await this.catalog.saveBlock(actor, parse(() => blockEditSchema.parse(body), "Некорректный блок")) };
  }

  private async mutating(request: unknown): Promise<ReturnType<typeof accountOf>> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
