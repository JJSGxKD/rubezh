import { Body, Controller, Delete, Get, HttpCode, Post, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PROXY_COUNTRY, PROXY_LIMITS } from "../proxies/proxies-rules.js";
import type { SubscriptionOverview } from "../proxies/subscription/subscription-views.js";
import { ProxySubscriptionService } from "../proxies/subscription/subscription.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Подписка Xray в панели (docs/29-admin-panel.md, раздел «Прокси»;
 * docs/35-stage4-plan.md Р101, tasks/T-0093). Смотреть — `proxies.view`,
 * менять — `proxies.edit`. Схема тела держит форму и пределы полей; кто видит
 * и что можно, решает сервис.
 *
 * Адрес подписки — только в теле записи. Нет `url` — прежний остаётся. Назад
 * адрес не уходит ни в одном ответе: только подсказка «хост …abcd».
 */

/** До десяти стран: больше фильтру незачем, а список в карточке остаётся читаемым. */
const COUNTRIES_MAX = 10;
/** Длиннее подписки не бывают; предел ограждает от мусора, а не от настоящих адресов. */
const URL_MAX = 2_048;

const saveSchema = z.strictObject({
  name: z.string().trim().min(1).max(PROXY_LIMITS.nameMax),
  url: z.string().trim().max(URL_MAX).optional(),
  countries: z.array(z.string().regex(PROXY_COUNTRY)).max(COUNTRIES_MAX).default([]),
  enabled: z.boolean(),
});

@Controller("admin/proxy-subscription")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminProxySubscriptionController {
  constructor(
    private readonly subscription: ProxySubscriptionService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("proxies.view")
  async view(@Req() request: unknown): Promise<{ data: SubscriptionOverview }> {
    return { data: await this.subscription.view(accountOf(request)) };
  }

  @Put()
  @RequirePermission("proxies.edit")
  async save(@Req() request: unknown, @Body() body: unknown): Promise<{ data: SubscriptionOverview }> {
    const actor = await this.mutating(request);
    const input = parse(() => saveSchema.parse(body), "Некорректные данные подписки: название, адрес, страны из двух заглавных букв (до десяти)");
    return { data: await this.subscription.save(actor, input) };
  }

  @Delete()
  @RequirePermission("proxies.edit")
  async remove(@Req() request: unknown): Promise<{ data: { removed: true } }> {
    const actor = await this.mutating(request);
    await this.subscription.remove(actor);
    return { data: { removed: true } };
  }

  @Post("refresh")
  @HttpCode(200)
  @RequirePermission("proxies.edit")
  async refresh(@Req() request: unknown): Promise<{ data: SubscriptionOverview }> {
    return { data: await this.subscription.refresh(await this.mutating(request)) };
  }

  @Post("probe")
  @HttpCode(200)
  @RequirePermission("proxies.edit")
  async probe(@Req() request: unknown): Promise<{ data: SubscriptionOverview }> {
    return { data: await this.subscription.probe(await this.mutating(request)) };
  }

  private async mutating(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
