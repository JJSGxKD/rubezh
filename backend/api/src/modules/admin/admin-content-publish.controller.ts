import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import type { ContentPointers } from "../content/content-publish.repository.js";
import { ContentPublishService, type CodeMergeResult, type PublicationPreview, type PublishResult, type RollbackResult } from "../content/content-publish.service.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Публикация контента в панели (docs/19-content-admin.md §4.4–§4.5,
 * tasks/T-0306): что в игре сейчас, готовность черновика к публикации,
 * публикация «Команде» и «Всем», откат и «Взять из кода». Публиковать и
 * откатывать — `content.publish`, сливать код в черновик — `content.edit`,
 * читать — `content.view`; каждое действие пишет аудит. Остальные маршруты
 * контента — `admin-content.controller.ts`.
 */

const idSchema = z.string().uuid();
const audienceSchema = z.enum(["team", "all"]);
const publishSchema = z.object({ audience: audienceSchema });
const versionNoSchema = z.number().int().min(1).max(2_147_483_647);
const rollbackSchema = z.object({ audience: audienceSchema, versionNo: versionNoSchema });
const mergeSchema = z.object({ versionNo: versionNoSchema.optional() });

@Controller("admin/content")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminContentPublishController {
  constructor(
    private readonly publication: ContentPublishService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Какая версия сейчас в игре у команды и у всех. */
  @Get("current")
  @RequirePermission("content.view")
  async current(@Req() request: unknown): Promise<{ data: ContentPointers & { requireCheck: boolean } }> {
    return { data: await this.publication.current(accountOf(request)) };
  }

  /** Готовность к публикации с причиной и правки против версии, которая в игре у аудитории. */
  @Get("drafts/:draftId/publication")
  @RequirePermission("content.view")
  async preview(@Req() request: unknown, @Param("draftId") draftId: string, @Query("audience") audience: unknown): Promise<{ data: PublicationPreview }> {
    const target = parse(() => audienceSchema.parse(audience), "Нужна аудитория: team или all");
    return { data: await this.publication.preview(accountOf(request), this.draftId(draftId), target) };
  }

  @Post("drafts/:draftId/publish")
  @RequirePermission("content.publish")
  async publish(@Req() request: unknown, @Param("draftId") draftId: string, @Body() body: unknown): Promise<{ data: PublishResult }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.contentPublish, actor.accountId))) throw new RateLimitedError("Слишком много публикаций — не больше двадцати за десять минут");
    const input = parse(() => publishSchema.parse(body), "Нужна аудитория: team или all");
    return { data: await this.publication.publish(actor, this.draftId(draftId), input.audience) };
  }

  /** Откат — не под лимитом публикаций: в аварии он должен пройти, сколько бы публикаций ни было до него. */
  @Post("rollback")
  @RequirePermission("content.publish")
  async rollback(@Req() request: unknown, @Body() body: unknown): Promise<{ data: RollbackResult }> {
    const actor = accountOf(request);
    await this.limitMutations(actor.accountId);
    const input = parse(() => rollbackSchema.parse(body), "Нужны аудитория (team или all) и номер версии");
    return { data: await this.publication.rollback(actor, input) };
  }

  @Post("drafts/:draftId/merge-code")
  @RequirePermission("content.edit")
  async mergeCode(@Req() request: unknown, @Param("draftId") draftId: string, @Body() body: unknown): Promise<{ data: CodeMergeResult }> {
    const actor = accountOf(request);
    await this.limitMutations(actor.accountId);
    const input = parse(() => mergeSchema.parse(body ?? {}), "Номер версии — целое число");
    return { data: await this.publication.mergeCode(actor, this.draftId(draftId), input.versionNo) };
  }

  private draftId(value: string): string {
    return parse(() => idSchema.parse(value), "Некорректный идентификатор черновика");
  }

  private async limitMutations(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
