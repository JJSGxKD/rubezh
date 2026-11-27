import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PartnerMaterialsService, materialInputSchema, type MaterialRow } from "../partners/partner-materials.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** «В архив» — без тела; «Вернуть из архива» — `{ archived: false }`. Лишнего не принимаем. */
const archiveSchema = z.object({ archived: z.boolean().default(true) }).strict();

const INVALID = "Некорректный материал: название, вид, текст или картинка не подходят";

/**
 * Материалы для партнёров в панели команды (docs/35-stage4-plan.md Р136, tasks/T-0221): баннеры, тексты постов и
 * правила — для всех партнёров или одному. Смотрят под `partners.view`, выкладывают, правят и убирают в архив под
 * `partners.edit`; каждое изменение — в аудит. Удаления нет: архивный материал партнёру не виден, но запись остаётся.
 * Кабинет партнёра читает те же материалы своим маршрутом — `GET /admin/cabinet/materials`.
 */
@Controller("admin/partner-materials")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPartnerMaterialsController {
  constructor(
    private readonly materials: PartnerMaterialsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("partners.view")
  async list(@Req() request: unknown): Promise<{ data: { materials: MaterialRow[] } }> {
    return { data: await this.materials.list(accountOf(request)) };
  }

  @Post()
  @RequirePermission("partners.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: MaterialRow }> {
    const actor = await this.consume(request);
    const input = parse(() => materialInputSchema.parse(body), INVALID);
    return { data: await this.materials.create(actor, input) };
  }

  @Post(":materialId")
  @RequirePermission("partners.edit")
  async update(@Req() request: unknown, @Param("materialId") materialId: string, @Body() body: unknown): Promise<{ data: MaterialRow }> {
    const actor = await this.consume(request);
    const input = parse(() => materialInputSchema.parse(body), INVALID);
    return { data: await this.materials.update(actor, materialIdOf(materialId), input) };
  }

  @Put(":materialId/archive")
  @RequirePermission("partners.edit")
  async archive(@Req() request: unknown, @Param("materialId") materialId: string, @Body() body: unknown): Promise<{ data: MaterialRow }> {
    const actor = await this.consume(request);
    const { archived } = parse(() => archiveSchema.parse(body ?? {}), "Нужно поле archived: true или false");
    return { data: await this.materials.setArchived(actor, materialIdOf(materialId), archived) };
  }

  private async consume(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}

function materialIdOf(raw: string): string {
  return parse(() => z.uuid().parse(raw), "Некорректный id материала");
}
