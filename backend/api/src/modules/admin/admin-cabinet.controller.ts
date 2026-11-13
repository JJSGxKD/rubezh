import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import {
  CABINET_LIMITS,
  CABINET_LINK_SOURCES,
  PartnerCabinet,
  type CabinetLink,
  type CabinetLinks,
  type CabinetOverview,
  type CabinetPromo,
  type CabinetPromos,
  type CabinetQuery,
} from "../partners/partner-cabinet.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Чужой кабинет для поддержки — по `partnerId`; ничего другого в запросе нет. */
const cabinetQuerySchema = z.object({ partnerId: z.uuid().optional() }).strict();

/**
 * Новая ссылка: название словами партнёра (в кампанию оно идёт латиницей), источник из списка, заметка.
 * Больше полей у кабинета нет: цель, сеть и постбэк — не выбор партнёра, и лишнее поле — ошибка, а не молча
 * брошенное значение.
 */
const newLinkSchema = z
  .object({
    campaign: z.string().trim().min(CABINET_LIMITS.campaignMin).max(80),
    source: z.enum(CABINET_LINK_SOURCES),
    note: z.string().trim().max(CABINET_LIMITS.noteMax).nullish(),
  })
  .strict();

/** Копия промокода: только новое слово. Награды, лимита и срока в теле нет и быть не может. */
const copySchema = z.object({ code: z.string().trim().min(1).max(CABINET_LIMITS.codeMax) }).strict();

/**
 * Кабинет партнёра в панели (docs/35-stage4-plan.md Р136, tasks/T-0217, T-0218): внешний человек с ролью `partner`
 * видит здесь только своё. Охранник сессии пускает любого с ролью, а **право проверяет `PartnerCabinet`**,
 * а не маршрут: своё — `partner.cabinet`, чужое глазами партнёра (`?partnerId=`, только чтение) —
 * `partners.view`. Одно право на маршруте не выразило бы «или то, или другое», а разделы кабинета следующих
 * задач берут партнёра той же точкой — `PartnerCabinet.partnerOf`.
 *
 * Запись (новая ссылка, копия промокода) принимает `?partnerId=` тоже — ради отказа «Кабинет открыт для
 * просмотра»: в режиме поддержки кабинет только читают.
 */
@Controller("admin/cabinet")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminCabinetController {
  constructor(
    private readonly cabinet: PartnerCabinet,
    private readonly limiter: RateLimiter,
  ) {}

  /** Карточка партнёра без контактов и заметок команды. */
  @Get()
  async overview(@Req() request: unknown, @Query() query: unknown): Promise<{ data: CabinetOverview }> {
    return { data: await this.cabinet.overview(accountOf(request), this.scope(query)) };
  }

  @Get("links")
  async links(@Req() request: unknown, @Query() query: unknown): Promise<{ data: CabinetLinks }> {
    return { data: await this.cabinet.links(accountOf(request), this.scope(query)) };
  }

  @Post("links")
  async createLink(@Req() request: unknown, @Query() query: unknown, @Body() body: unknown): Promise<{ data: CabinetLink }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const input = parse(() => newLinkSchema.parse(body), "Название — от двух знаков, источник — из списка, заметка — до 120 знаков");
    return { data: await this.cabinet.createLink(actor, this.scope(query), { campaign: input.campaign, source: input.source, note: input.note ?? null }) };
  }

  @Get("promos")
  async promos(@Req() request: unknown, @Query() query: unknown): Promise<{ data: CabinetPromos }> {
    return { data: await this.cabinet.promos(accountOf(request), this.scope(query)) };
  }

  @Post("promos/:campaignId/copy")
  async copyPromo(@Req() request: unknown, @Param("campaignId") campaignId: string, @Query() query: unknown, @Body() body: unknown): Promise<{ data: CabinetPromo }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const id = parse(() => z.uuid().parse(campaignId), "Некорректный промокод");
    const { code } = parse(() => copySchema.parse(body), `Нужно новое кодовое слово — до ${String(CABINET_LIMITS.codeMax)} знаков`);
    return { data: await this.cabinet.copyPromo(actor, this.scope(query), id, code) };
  }

  private scope(query: unknown): CabinetQuery {
    return parse(() => cabinetQuerySchema.parse(query), "Некорректный запрос кабинета");
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
