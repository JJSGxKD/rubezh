import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { SETTING_KEY } from "../settings/setting-catalog.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminSettingsService, type SettingView } from "./admin-settings.service.js";

/**
 * Настройки без релиза в панели: список, запись, сброс к окружению. Схему
 * значения знает каталог — здесь только его форма: строка или флажок.
 */
const saveSchema = z.object({ value: z.union([z.string().max(256), z.boolean()]) });

@Controller("admin/settings")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminSettingsController {
  constructor(
    private readonly settings: AdminSettingsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("settings.edit")
  async list(@Req() request: unknown): Promise<{ data: { settings: SettingView[] } }> {
    return { data: { settings: await this.settings.list(accountOf(request)) } };
  }

  @Post(":key")
  @RequirePermission("settings.edit")
  async save(@Req() request: unknown, @Param("key") key: string, @Body() body: unknown): Promise<{ data: SettingView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const { value } = parse(() => saveSchema.parse(body), "Значение — строка или флажок");
    return { data: await this.settings.save(actor, keyOf(key), value) };
  }

  @Post(":key/reset")
  @RequirePermission("settings.edit")
  async reset(@Req() request: unknown, @Param("key") key: string): Promise<{ data: SettingView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    return { data: await this.settings.reset(actor, keyOf(key)) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}

function keyOf(key: string): string {
  return parse(() => z.string().regex(SETTING_KEY).parse(key), "Некорректный ключ настройки");
}
