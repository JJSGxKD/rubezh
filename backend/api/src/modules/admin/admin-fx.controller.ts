import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { manualRateSchema, sourceLimitSchema, sourceUsedSchema } from "../fx/dto/fx.dto.js";
import { FxService, type FxOverview, type ManualView, type SourceView } from "../fx/fx.service.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Курсы валют в панели (docs/35-stage4-plan.md, §3.12): обзор со свежестью
 * и бюджетами источников, заданные курсы звёзд — цена для игрока и выплата нам.
 * Те же вызовы, что у `/fx/admin`, но под cookie-сессией панели.
 */
@Controller("admin/fx")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminFxController {
  constructor(
    private readonly fx: FxService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("analytics.revenue.view")
  async overview(): Promise<{ data: FxOverview }> {
    return { data: await this.fx.overview() };
  }

  @Post("manual")
  @RequirePermission("fx.rates.edit")
  async setManual(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ManualView }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return { data: await this.fx.setManual(actor, parse(() => manualRateSchema.parse(body), "Некорректный курс")) };
  }

  /** Месячный лимит источника вместо тарифа из кода; `perMonth: null` — без лимита. */
  @Put("sources/:source/limit")
  @RequirePermission("fx.rates.edit")
  async setLimit(@Req() request: unknown, @Param("source") source: string, @Body() body: unknown): Promise<{ data: SourceView }> {
    const actor = accountOf(request);
    await this.throttle(actor.accountId);
    const input = parse(() => sourceLimitSchema.parse(body), "Некорректный лимит");
    return { data: await this.fx.setLimit(actor, source, input.perMonth, input.note) };
  }

  /** Вернуть тариф из кода. */
  @Delete("sources/:source/limit")
  @RequirePermission("fx.rates.edit")
  async resetLimit(@Req() request: unknown, @Param("source") source: string): Promise<{ data: SourceView }> {
    const actor = accountOf(request);
    await this.throttle(actor.accountId);
    return { data: await this.fx.resetLimit(actor, source) };
  }

  /** Поправить счётчик запросов за текущий месяц: он разошёлся с кабинетом поставщика. */
  @Put("sources/:source/used")
  @RequirePermission("fx.rates.edit")
  async correctUsed(@Req() request: unknown, @Param("source") source: string, @Body() body: unknown): Promise<{ data: SourceView }> {
    const actor = accountOf(request);
    await this.throttle(actor.accountId);
    const input = parse(() => sourceUsedSchema.parse(body), "Некорректный счётчик");
    return { data: await this.fx.correctUsed(actor, source, input.used, input.note) };
  }

  private async throttle(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
