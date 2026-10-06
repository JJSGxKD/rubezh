import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { ConversionsJournal, parseCursor } from "../ad-conversions/conversions-journal.service.js";
import { emptySummary, type ConversionRow, type ConversionSummary } from "../ad-conversions/conversions.repository.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { LINK_CODE } from "../links/link-code.js";
import { LINK_NETWORKS } from "../links/link-networks.js";
import type { LinkStats } from "../links/links.repository.js";
import { LinksService, type LinkView } from "../links/links.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { SECRETS } from "../secrets/secret-catalog.js";
import { SecretsService } from "../secrets/secrets.service.js";
import { LinkNotFoundError } from "./admin-errors.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Ссылки кампаний в панели (docs/24-attribution-and-sharing.md §3, WP16):
 * завести ссылку и видеть клики и запуски по ней. Кампания и источник —
 * латиница, цифры и дефис: они уходят в разрезы аналитики, и «Канал
 * запуска» с пробелом и кириллицей там разъехался бы с `channel-launch`.
 *
 * Ссылка сети (WP43, Р86) — ещё и адрес с макросами для кабинета сети и
 * журнал конверсий, ушедших в него.
 */
const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "латиница в нижнем регистре, цифры, дефис и подчёркивание");
const newLinkSchema = z.object({
  campaign: slug,
  source: slug.optional(),
  medium: slug.optional(),
  note: z.string().trim().max(200).optional(),
  network: z.enum(LINK_NETWORKS).optional(),
  registrationOn: z.enum(["first_run", "launch"]).optional(),
});
const journalQuerySchema = z.object({ before: z.string().max(80).optional() });
const conversionIdSchema = z.uuid();

type LinkListRow = LinkView<LinkStats> & { conversions: ConversionSummary | null };

@Controller("admin/links")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminLinksController {
  constructor(
    private readonly links: LinksService,
    private readonly journal: ConversionsJournal,
    private readonly secrets: SecretsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("links.manage")
  async list(@Req() request: unknown): Promise<{ data: { links: LinkListRow[]; postback: { adsgramToken: boolean } } }> {
    const links = await this.links.list(accountOf(request));
    const summaries = await this.journal.summaries(links.filter((link) => link.network !== null).map((link) => link.code));
    return {
      data: {
        links: links.map((link) => ({ ...link, conversions: link.network === null ? null : (summaries.get(link.code) ?? emptySummary()) })),
        // Задан ли токен нашего кабинета — без значения: маркетологу его видеть незачем.
        postback: { adsgramToken: this.secrets.get(SECRETS.adsgramConversionToken) !== null },
      },
    };
  }

  @Post()
  @RequirePermission("links.manage")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: LinkView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const input = parse(() => newLinkSchema.parse(body), "Кампания и источник — латиница в нижнем регистре, цифры, дефис");
    return {
      data: await this.links.create(actor, {
        campaign: input.campaign,
        source: input.source ?? null,
        medium: input.medium ?? null,
        note: input.note || null,
        platform: "telegram",
        network: input.network ?? null,
        registrationOn: input.registrationOn ?? "first_run",
      }),
    };
  }

  @Get(":code/conversions")
  @RequirePermission("links.manage")
  async conversions(@Req() request: unknown, @Param("code") code: string, @Query() query: unknown): Promise<{ data: { conversions: ConversionRow[]; next: string | null } }> {
    const { before } = parse(() => journalQuerySchema.parse(query), "Некорректный курсор журнала");
    const cursor = before === undefined ? null : parseCursor(before);
    if (before !== undefined && cursor === null) throw new ValidationError("Некорректный курсор журнала");
    return { data: await this.journal.page(accountOf(request), await this.linkCode(code), cursor) };
  }

  @Post(":code/conversions/:conversionId/send")
  @RequirePermission("links.manage")
  async send(@Req() request: unknown, @Param("code") code: string, @Param("conversionId") conversionId: string): Promise<{ data: ConversionRow }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const id = parse(() => conversionIdSchema.parse(conversionId), "Некорректная конверсия");
    const row = await this.journal.requeue(actor, await this.linkCode(code), id);
    if (row === null) throw new LinkNotFoundError("Такой неотправленной конверсии у ссылки нет — возможно, она уже ушла");
    return { data: row };
  }

  private async linkCode(code: string): Promise<string> {
    if (!LINK_CODE.test(code) || (await this.links.byCode(code)) === null) throw new LinkNotFoundError("Ссылки с таким кодом нет");
    return code;
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
