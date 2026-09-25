import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import type { LinkRecord, LinkStats } from "../links/links.repository.js";
import { LinksService } from "../links/links.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Ссылки кампаний в панели (docs/24-attribution-and-sharing.md §3, WP16):
 * завести ссылку и видеть клики и запуски по ней. Кампания и источник —
 * латиница, цифры и дефис: они уходят в разрезы аналитики, и «Канал
 * запуска» с пробелом и кириллицей там разъехался бы с `channel-launch`.
 */
const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "латиница в нижнем регистре, цифры, дефис и подчёркивание");
const newLinkSchema = z.object({
  campaign: slug,
  source: slug.optional(),
  medium: slug.optional(),
  note: z.string().trim().max(200).optional(),
});

@Controller("admin/links")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminLinksController {
  constructor(
    private readonly links: LinksService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("links.manage")
  async list(@Req() request: unknown): Promise<{ data: { links: (LinkStats & { url: string })[] } }> {
    return { data: { links: await this.links.list(accountOf(request)) } };
  }

  @Post()
  @RequirePermission("links.manage")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: LinkRecord & { url: string } }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    const input = parse(() => newLinkSchema.parse(body), "Кампания и источник — латиница в нижнем регистре, цифры, дефис");
    return {
      data: await this.links.create(actor, { campaign: input.campaign, source: input.source ?? null, medium: input.medium ?? null, note: input.note || null, platform: "telegram" }),
    };
  }
}
