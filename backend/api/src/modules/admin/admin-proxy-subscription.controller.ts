import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PROXY_COUNTRY, PROXY_LIMITS } from "../proxies/proxies-rules.js";
import { SUBSCRIPTION_KEY_FORMAT } from "../proxies/subscription/subscription-rules.js";
import type { SubscriptionsOverview } from "../proxies/subscription/subscription-views.js";
import { ProxySubscriptionService } from "../proxies/subscription/subscription.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Подписки Xray в панели (docs/29-admin-panel.md, раздел «Прокси»;
 * docs/35-stage4-plan.md Р101, Р192, tasks/T-0093, tasks/T-0384). Смотреть —
 * `proxies.view`, менять — `proxies.edit`. Схема тела держит форму и пределы
 * полей; кто видит и что можно, решает сервис.
 *
 * Подписок несколько, каждая под своим ключом (`:key`): его выдаёт сервер при
 * создании, из тела он не берётся. Адрес подписки — только в теле записи. При
 * правке нет `url` — прежний остаётся. Назад адрес не уходит ни в одном ответе:
 * только подсказка «хост …abcd».
 */

/** До десяти стран: больше фильтру незачем, а список в карточке остаётся читаемым. */
const COUNTRIES_MAX = 10;
/** Длиннее подписки не бывают; предел ограждает от мусора, а не от настоящих адресов. */
const URL_MAX = 2_048;

const fields = {
  name: z.string().trim().min(1).max(PROXY_LIMITS.nameMax),
  countries: z.array(z.string().regex(PROXY_COUNTRY)).max(COUNTRIES_MAX).default([]),
  enabled: z.boolean(),
};
/** Адрес необязателен схеме: при создании пустой ответит сервис («Укажите адрес подписки»), при правке пустой — прежний. */
const saveSchema = z.strictObject({ ...fields, url: z.string().trim().max(URL_MAX).optional() });
const keySchema = z.string().regex(SUBSCRIPTION_KEY_FORMAT);

const BAD_BODY = "Некорректные данные подписки: название, адрес, страны из двух заглавных букв (до десяти)";
const BAD_KEY = "Некорректный ключ подписки";

@Controller("admin/proxy-subscriptions")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminProxySubscriptionController {
  constructor(
    private readonly subscription: ProxySubscriptionService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("proxies.view")
  async list(@Req() request: unknown): Promise<{ data: SubscriptionsOverview }> {
    return { data: await this.subscription.list(accountOf(request)) };
  }

  @Post()
  @RequirePermission("proxies.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: SubscriptionsOverview }> {
    const actor = await this.mutating(request);
    const input = parse(() => saveSchema.parse(body), BAD_BODY);
    return { data: await this.subscription.create(actor, input) };
  }

  @Put(":key")
  @RequirePermission("proxies.edit")
  async update(@Req() request: unknown, @Param("key") key: string, @Body() body: unknown): Promise<{ data: SubscriptionsOverview }> {
    const actor = await this.mutating(request);
    const input = parse(() => saveSchema.parse(body), BAD_BODY);
    return { data: await this.subscription.update(actor, this.keyOf(key), input) };
  }

  @Delete(":key")
  @RequirePermission("proxies.edit")
  async remove(@Req() request: unknown, @Param("key") key: string): Promise<{ data: { removed: true } }> {
    const actor = await this.mutating(request);
    await this.subscription.remove(actor, this.keyOf(key));
    return { data: { removed: true } };
  }

  @Post(":key/refresh")
  @HttpCode(200)
  @RequirePermission("proxies.edit")
  async refresh(@Req() request: unknown, @Param("key") key: string): Promise<{ data: SubscriptionsOverview }> {
    return { data: await this.subscription.refresh(await this.mutating(request), this.keyOf(key)) };
  }

  @Post(":key/probe")
  @HttpCode(200)
  @RequirePermission("proxies.edit")
  async probe(@Req() request: unknown, @Param("key") key: string): Promise<{ data: SubscriptionsOverview }> {
    return { data: await this.subscription.probe(await this.mutating(request), this.keyOf(key)) };
  }

  /** Ключ из пути: не по формату — 400 до обращения к сервису и базе. */
  private keyOf(raw: string): string {
    return parse(() => keySchema.parse(raw), BAD_KEY);
  }

  private async mutating(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
