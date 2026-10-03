import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import type { SecretCheckResult } from "../secrets/secret-catalog.js";
import { SECRET_KEY } from "../secrets/secret-catalog.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSecretsService, type GeneratedSecretView, type SecretView, type SecretsOverview } from "./admin-secrets.service.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Ключи интеграций в панели: состояние, замена, проверка связи, сброс к
 * окружению. Вид ключа знает каталог — здесь только форма тела.
 */
const saveSchema = z.object({ value: z.string().max(1024) });
const checkSchema = z.object({ value: z.string().max(1024).optional() }).optional();

@Controller("admin/secrets")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminSecretsController {
  constructor(
    private readonly secrets: AdminSecretsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("secrets.view")
  async list(@Req() request: unknown): Promise<{ data: SecretsOverview }> {
    return { data: await this.secrets.list(accountOf(request)) };
  }

  @Post(":key")
  @RequirePermission("secrets.edit")
  async save(@Req() request: unknown, @Param("key") key: string, @Body() body: unknown): Promise<{ data: SecretView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId, "mutate");
    const { value } = parse(() => saveSchema.parse(body), "Ключ — строка");
    return { data: await this.secrets.save(actor, keyOf(key), value) };
  }

  @Post(":key/generate")
  @RequirePermission("secrets.edit")
  async generate(@Req() request: unknown, @Param("key") key: string): Promise<{ data: GeneratedSecretView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId, "mutate");
    return { data: await this.secrets.generate(actor, keyOf(key)) };
  }

  @Post(":key/reset")
  @RequirePermission("secrets.edit")
  async reset(@Req() request: unknown, @Param("key") key: string): Promise<{ data: SecretView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId, "mutate");
    return { data: await this.secrets.reset(actor, keyOf(key)) };
  }

  @Post(":key/check")
  @RequirePermission("secrets.view")
  async check(@Req() request: unknown, @Param("key") key: string, @Body() body: unknown): Promise<{ data: SecretCheckResult }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId, "secretCheck");
    const parsed = parse(() => checkSchema.parse(body), "Ключ — строка");
    return { data: await this.secrets.check(actor, keyOf(key), parsed?.value ?? null) };
  }

  private async limit(accountId: string, kind: "mutate" | "secretCheck"): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS[kind], accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}

function keyOf(key: string): string {
  return parse(() => z.string().regex(SECRET_KEY).parse(key), "Некорректное имя ключа");
}
