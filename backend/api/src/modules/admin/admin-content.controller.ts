import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { PATH_MAX_LENGTH } from "../content/content-path.js";
import { ContentCheckService, type ContentCheckView, type StartedCheck } from "../content/content-check.service.js";
import type { ContentDraftSummary, ContentVersionRecord, ContentVersionSummary } from "../content/content.repository.js";
import { ContentService, DRAFT_TITLE_MAX, type ContentDraftDetail, type ContentDraftView, type DraftDiff, type PatchResult } from "../content/content.service.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Контент игры в панели (docs/19-content-admin.md §3, tasks/T-0303): версии,
 * черновики поверх них, правка по пути, проверка в sim-worker и разница с
 * базой. Читать — `content.view`, править и проверять — `content.edit`; каждое
 * изменение пишет аудит. Публикации здесь нет (T-0306).
 */

const idSchema = z.string().uuid();
const createSchema = z.object({
  title: z.string().max(DRAFT_TITLE_MAX * 2),
  baseVersionNo: z.number().int().min(1).max(2_147_483_647).optional(),
});
const patchSchema = z
  .object({ path: z.string().min(1).max(PATH_MAX_LENGTH), value: z.unknown() })
  .refine((body) => body.value !== undefined, { message: "value обязателен" });
const versionNoSchema = z.coerce.number().int().min(1).max(2_147_483_647);
const archivedSchema = z.enum(["0", "1", "true", "false"]).optional();

@Controller("admin/content")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminContentController {
  constructor(
    private readonly content: ContentService,
    private readonly checks: ContentCheckService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get("versions")
  @RequirePermission("content.view")
  async versions(@Req() request: unknown): Promise<{ data: ContentVersionSummary[] }> {
    return { data: await this.content.versions(accountOf(request)) };
  }

  @Get("versions/:versionNo")
  @RequirePermission("content.view")
  async version(@Req() request: unknown, @Param("versionNo") versionNo: string): Promise<{ data: ContentVersionRecord }> {
    const no = parse(() => versionNoSchema.parse(versionNo), "Некорректный номер версии");
    return { data: await this.content.version(accountOf(request), no) };
  }

  @Get("drafts")
  @RequirePermission("content.view")
  async drafts(@Req() request: unknown, @Query("archived") archived: unknown): Promise<{ data: ContentDraftSummary[] }> {
    const flag = parse(() => archivedSchema.parse(archived), "Некорректный отбор черновиков");
    return { data: await this.content.drafts(accountOf(request), flag === "1" || flag === "true") };
  }

  @Post("drafts")
  @RequirePermission("content.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: ContentDraftView }> {
    const actor = accountOf(request);
    await this.limitMutations(actor.accountId);
    const input = parse(() => createSchema.parse(body), "Некорректный черновик");
    return { data: await this.content.createDraft(actor, input) };
  }

  @Get("drafts/:draftId")
  @RequirePermission("content.view")
  async draft(@Req() request: unknown, @Param("draftId") draftId: string): Promise<{ data: ContentDraftDetail }> {
    return { data: await this.content.draft(accountOf(request), this.draftId(draftId)) };
  }

  @Patch("drafts/:draftId")
  @RequirePermission("content.edit")
  async patch(@Req() request: unknown, @Param("draftId") draftId: string, @Body() body: unknown): Promise<{ data: PatchResult }> {
    const actor = accountOf(request);
    await this.limitMutations(actor.accountId);
    const id = this.draftId(draftId);
    const input = parse(() => patchSchema.parse(body), "Нужны path и value");
    return { data: await this.content.patchDraft(actor, id, { path: input.path, value: input.value }) };
  }

  @Post("drafts/:draftId/archive")
  @RequirePermission("content.edit")
  async archive(@Req() request: unknown, @Param("draftId") draftId: string): Promise<{ data: ContentDraftSummary }> {
    const actor = accountOf(request);
    await this.limitMutations(actor.accountId);
    return { data: await this.content.archiveDraft(actor, this.draftId(draftId)) };
  }

  @Get("drafts/:draftId/diff")
  @RequirePermission("content.view")
  async diff(@Req() request: unknown, @Param("draftId") draftId: string): Promise<{ data: DraftDiff }> {
    return { data: await this.content.diff(accountOf(request), this.draftId(draftId)) };
  }

  @Post("drafts/:draftId/check")
  @RequirePermission("content.edit")
  async check(@Req() request: unknown, @Param("draftId") draftId: string): Promise<{ data: StartedCheck }> {
    const actor = accountOf(request);
    // Лимит считает и повторы того же снимка: он бережёт запросы к базе и очереди, а не только воркер.
    if (!(await this.limiter.consume(ADMIN_LIMITS.contentCheck, actor.accountId))) throw new RateLimitedError("Слишком много проверок — не больше десяти за десять минут");
    return { data: await this.checks.start(actor, this.draftId(draftId)) };
  }

  @Get("checks/:checkId")
  @RequirePermission("content.view")
  async readCheck(@Req() request: unknown, @Param("checkId") checkId: string): Promise<{ data: ContentCheckView }> {
    const id = parse(() => idSchema.parse(checkId), "Некорректный идентификатор проверки");
    return { data: await this.checks.read(accountOf(request), id) };
  }

  private draftId(value: string): string {
    return parse(() => idSchema.parse(value), "Некорректный идентификатор черновика");
  }

  private async limitMutations(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
