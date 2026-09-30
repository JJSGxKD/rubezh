import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { accountOf } from "../auth/auth.guard.js";
import { CHANGELOG_KINDS, CHANGELOG_TEXT_MAX, VERSION_PATTERN } from "../changelog/changelog-rules.js";
import type { ChangelogEntryRecord } from "../changelog/changelog.repository.js";
import { ChangelogService, type ChangelogAdminView, type PublishResult } from "../changelog/changelog.service.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Журнал обновлений в панели (docs/35-stage4-plan.md WP31): все строки с
 * метками площадок и черновиками, правка — `changelog.edit`, публикация
 * версии — `changelog.publish`: она раздаёт уведомление всем игрокам
 * площадок. Каждое изменение — в аудит.
 */
const VERSION_MESSAGE = "версия — X.Y.Z без предрелиза, например 0.6.0";

const entrySchema = z.object({
  entryId: z.string().uuid().optional(),
  version: z.string().regex(VERSION_PATTERN, VERSION_MESSAGE),
  kind: z.enum(CHANGELOG_KINDS),
  platforms: z.array(z.enum(PLATFORM_IDS)).max(PLATFORM_IDS.length).default([]),
  // Переносы строк — как набрали; пробелы по краям — нет: пустую строку проверка базы всё равно не пропустит.
  text: z.string().trim().min(1, "текст пустой").max(CHANGELOG_TEXT_MAX),
});

const publishSchema = z.object({ version: z.string().regex(VERSION_PATTERN, VERSION_MESSAGE) });

@Controller("admin/changelog")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminChangelogController {
  constructor(
    private readonly changelog: ChangelogService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("changelog.edit")
  async list(@Req() request: unknown): Promise<{ data: ChangelogAdminView }> {
    return { data: await this.changelog.list(accountOf(request)) };
  }

  @Post()
  @RequirePermission("changelog.edit")
  async save(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ChangelogEntryRecord }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const input = parse(() => entrySchema.parse(body), "Некорректная строка журнала");
    return { data: await this.changelog.save(actor, { version: input.version, kind: input.kind, platforms: input.platforms, text: input.text, ...(input.entryId === undefined ? {} : { entryId: input.entryId }) }) };
  }

  @Post("publish")
  @RequirePermission("changelog.publish")
  async publish(@Req() request: unknown, @Body() body: unknown): Promise<{ data: PublishResult }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const input = parse(() => publishSchema.parse(body), "Некорректная версия");
    return { data: await this.changelog.publish(actor, input.version) };
  }

  @Post(":entryId/remove")
  @RequirePermission("changelog.edit")
  async remove(@Req() request: unknown, @Param("entryId") entryId: string): Promise<{ data: { removed: boolean } }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const id = parse(() => z.string().uuid().parse(entryId), "Некорректная строка журнала");
    return { data: await this.changelog.remove(actor, id) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
