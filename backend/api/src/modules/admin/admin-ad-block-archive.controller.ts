import { Controller, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { AdBlockArchiveService } from "../ads/ad-block-archive.service.js";
import type { AdCatalogBlock } from "../ads/ads-catalog.repository.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Архив рекламных блоков в панели (docs/35-stage4-plan.md Р200): «В архив»
 * выключает блок и убирает его из списка, «Вернуть» возвращает блок выключенным.
 * Отдельный контроллер, а не ручки `AdminAdsController`: новая зависимость в его
 * конструкторе потребовала бы сборки сервиса архива во всех HTTP-тестах каталога.
 */
const blockIdSchema = z.string().uuid();

@Controller("admin/ads/blocks")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminAdBlockArchiveController {
  constructor(
    private readonly archive: AdBlockArchiveService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post(":blockId/archive")
  @RequirePermission("ads.edit")
  async archiveBlock(@Req() request: unknown, @Param("blockId") blockId: string): Promise<{ data: AdCatalogBlock }> {
    const actor = await this.mutating(request);
    return { data: await this.archive.archive(actor, parse(() => blockIdSchema.parse(blockId), "Некорректный блок")) };
  }

  @Post(":blockId/unarchive")
  @RequirePermission("ads.edit")
  async unarchiveBlock(@Req() request: unknown, @Param("blockId") blockId: string): Promise<{ data: AdCatalogBlock }> {
    const actor = await this.mutating(request);
    return { data: await this.archive.unarchive(actor, parse(() => blockIdSchema.parse(blockId), "Некорректный блок")) };
  }

  private async mutating(request: unknown): Promise<ReturnType<typeof accountOf>> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
