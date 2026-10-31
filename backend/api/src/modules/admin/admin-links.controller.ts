import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { ConversionsJournal, parseCursor } from "../ad-conversions/conversions-journal.service.js";
import { emptySummary, type ConversionRow, type ConversionSummary } from "../ad-conversions/conversions.repository.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import type { UnknownKeyRow } from "../links/auto-sources.repository.js";
import { LINK_CODE } from "../links/link-code.js";
import { LINK_NETWORKS } from "../links/link-networks.js";
import { LINK_TARGETS } from "../links/link-targets.js";
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
 *
 * Ссылка партнёра (Р96, T-0067) — та же ссылка с владельцем `partnerId`: он
 * задаётся при создании, `PATCH` его не принимает, а список фильтруется
 * по `?partner=<id>`.
 */
const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "латиница в нижнем регистре, цифры, дефис и подчёркивание");
const newLinkSchema = z.object({
  campaign: slug,
  source: slug.optional(),
  medium: slug.optional(),
  note: z.string().trim().max(200).optional(),
  network: z.enum(LINK_NETWORKS).optional(),
  registrationOn: z.enum(["first_run", "launch"]).optional(),
  target: z.enum(LINK_TARGETS).optional(),
  partnerId: z.uuid().optional(),
});
// Строго: владельца после создания не сменить, и лишнее поле в теле — ошибка, а не молчаливо брошенный `partnerId`.
const retargetSchema = z.object({ target: z.enum(LINK_TARGETS) }).strict();
/**
 * Название и скрытие автоисточника (T-0180): хотя бы одно поле, лишних нет. Название — одна строка
 * без управляющих знаков, 1–80 после обрезки; пустая строка и `null` сбрасывают его.
 */
const displaySchema = z
  .object({
    title: z
      .string()
      .max(200)
      .refine((value) => !/\p{Cc}/u.test(value.trim()), { message: "без управляющих знаков" })
      .transform((value) => value.trim())
      .pipe(z.string().max(80, "не длиннее 80 знаков"))
      .nullable()
      .optional(),
    hidden: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.hidden !== undefined, { message: "нужно название или скрытие" });
const listQuerySchema = z.object({ partner: z.uuid().optional() });
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
  async list(@Req() request: unknown, @Query() query: unknown): Promise<{ data: { links: LinkListRow[]; postback: { adsgramToken: boolean } } }> {
    const { partner } = parse(() => listQuerySchema.parse(query), "Партнёр в фильтре — идентификатор из карточки партнёра");
    const links = await this.links.list(accountOf(request), partner === undefined ? {} : { partnerId: partner });
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
        target: input.target ?? "app",
        partnerId: input.partnerId ?? null,
      }),
    };
  }

  /** Сменить цель: прошлые клики остаются, новые идут по-новому. Сеть, код и владелец не меняются. */
  @Patch(":code")
  @RequirePermission("links.manage")
  async retarget(@Req() request: unknown, @Param("code") code: string, @Body() body: unknown): Promise<{ data: LinkView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const { target } = parse(() => retargetSchema.parse(body), "Меняется только цель ссылки — Mini App, бот или лендинг; владельца после создания не сменить");
    const link = await this.links.retarget(actor, await this.linkCode(code), target);
    if (link === null) throw new LinkNotFoundError("Ссылки с таким кодом нет");
    return { data: link };
  }

  /** Сводка незнакомых ключей параметра запуска. Объявлена выше маршрутов с `:code`. */
  @Get("unknown-keys")
  @RequirePermission("links.manage")
  async unknownKeys(@Req() request: unknown): Promise<{ data: { keys: UnknownKeyRow[]; limit: number } }> {
    return { data: await this.links.unknownKeys(accountOf(request)) };
  }

  /**
   * Название и скрытие автоисточника: `campaign` и `source` не меняются, по ним идут разрезы аналитики.
   * У ссылки, заведённой руками, — 400.
   */
  @Patch(":code/display")
  @RequirePermission("links.manage")
  async display(@Req() request: unknown, @Param("code") code: string, @Body() body: unknown): Promise<{ data: LinkView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const { title, hidden } = parse(() => displaySchema.parse(body), "Название — до 80 знаков без управляющих, скрытие — да или нет; нужно хотя бы одно");
    const id = await this.linkCode(code);
    let link: LinkView | null = null;
    if (title !== undefined) link = await this.links.rename(actor, id, title === "" ? null : title);
    if (hidden !== undefined) link = await this.links.setHidden(actor, id, hidden);
    if (link === null) throw new LinkNotFoundError("Ссылки с таким кодом нет");
    return { data: link };
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
