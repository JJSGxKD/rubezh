import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { OUTBOUND_MODES } from "../../infra/outbound/outbound-route.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PROXY_COUNTRY, PROXY_LIMITS, PROXY_SCHEMES, isProxyHost } from "../proxies/proxies-rules.js";
import { ProxiesService } from "../proxies/proxies.service.js";
import type { CheckView, ModeView, ProxiesView, ProxyView } from "../proxies/proxy-views.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Прокси для исходящих запросов в панели (docs/29-admin-panel.md, раздел
 * «Прокси»; docs/35-stage4-plan.md Р91). Смотреть — `proxies.view`, менять и
 * проверять — `proxies.edit`. Схема тела держит форму и пределы полей; кто
 * видит экран и что можно, решает сервис.
 *
 * Пароль — только в теле записи. Пустой — не менять; «Удалить пароль» — явный
 * `clearPassword`. Назад пароль не уходит ни в одном ответе.
 */
const nameSchema = z.string().trim().min(1).max(PROXY_LIMITS.nameMax);
const hostSchema = z.string().trim().refine(isProxyHost);
const portSchema = z.number().int().min(1).max(65_535);
const countrySchema = z.string().regex(PROXY_COUNTRY);
const usernameSchema = z.string().max(PROXY_LIMITS.usernameMax).nullable();
const passwordSchema = z.string().max(PROXY_LIMITS.passwordMax);
const noteSchema = z.string().max(PROXY_LIMITS.noteMax).nullable();
const prioritySchema = z.number().int().min(0).max(PROXY_LIMITS.priorityMax);

const createSchema = z.strictObject({
  name: nameSchema,
  scheme: z.enum(PROXY_SCHEMES),
  host: hostSchema,
  port: portSchema,
  username: usernameSchema.optional(),
  password: passwordSchema.optional(),
  country: countrySchema,
  enabled: z.boolean().optional(),
  priority: prioritySchema.optional(),
  note: noteSchema.optional(),
});
const patchSchema = createSchema
  .partial()
  .extend({ clearPassword: z.boolean().optional() })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: "Нужно хотя бы одно поле" });
const modeSchema = z.strictObject({ mode: z.enum(OUTBOUND_MODES) });
const idSchema = z.string().uuid();
const serviceSchema = z.string().min(1).max(32);

@Controller("admin/proxies")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminProxiesController {
  constructor(
    private readonly proxies: ProxiesService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("proxies.view")
  async list(@Req() request: unknown): Promise<{ data: ProxiesView }> {
    return { data: await this.proxies.list(accountOf(request)) };
  }

  @Get("modes")
  @RequirePermission("proxies.view")
  async modes(@Req() request: unknown): Promise<{ data: { modes: ModeView[] } }> {
    return { data: { modes: await this.proxies.modes(accountOf(request)) } };
  }

  @Put("modes/:service")
  @RequirePermission("proxies.edit")
  async setMode(@Req() request: unknown, @Param("service") service: string, @Body() body: unknown): Promise<{ data: ModeView }> {
    const actor = await this.mutating(request);
    const { mode } = parse(() => modeSchema.parse(body), "Режим — «Сначала напрямую», «Только через прокси» или «Только напрямую»");
    return { data: await this.proxies.setMode(actor, parse(() => serviceSchema.parse(service), "Некорректное имя сервиса"), mode) };
  }

  @Post()
  @RequirePermission("proxies.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ProxyView }> {
    const actor = await this.mutating(request);
    return { data: await this.proxies.create(actor, parse(() => createSchema.parse(body), "Некорректные данные прокси")) };
  }

  @Patch(":proxyId")
  @RequirePermission("proxies.edit")
  async update(@Req() request: unknown, @Param("proxyId") proxyId: string, @Body() body: unknown): Promise<{ data: ProxyView }> {
    const actor = await this.mutating(request);
    const patch = parse(() => patchSchema.parse(body), "Некорректные данные прокси");
    return { data: await this.proxies.update(actor, idOf(proxyId), patch) };
  }

  @Post(":proxyId/check")
  @HttpCode(200)
  @RequirePermission("proxies.edit")
  async check(@Req() request: unknown, @Param("proxyId") proxyId: string): Promise<{ data: CheckView }> {
    const actor = accountOf(request);
    // Проверка ходит наружу через прокси — тот же счётчик, что у проверки ключей интеграций.
    if (!(await this.limiter.consume(ADMIN_LIMITS.secretCheck, actor.accountId))) throw new RateLimitedError("Слишком много проверок — подождите минуту");
    return { data: await this.proxies.check(actor, idOf(proxyId)) };
  }

  private async mutating(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}

const idOf = (value: string): string => parse(() => idSchema.parse(value), "Некорректный идентификатор прокси");
