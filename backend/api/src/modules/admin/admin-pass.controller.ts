import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { PassAdminService, type PassSeasonsView, type PassSeasonView } from "../battle-pass/pass-admin.service.js";
import { PASS_TIERS, tierEditSchema } from "../battle-pass/pass-rules.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Ленты батл-пасса по месяцам в панели (docs/35-stage4-plan.md Р46, §3.15;
 * tasks/T-0313): месяцы, 30 ступеней двух лент, копия прошлого месяца,
 * публикация — под `pass.edit`, каждое изменение — в аудит. Правила (прошлое
 * только для чтения, пройденные ступени не правятся, награда без случайного) —
 * в `PassAdminService`.
 */

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const createSchema = z.object({ month: monthSchema, from: monthSchema.optional() }).strict();
const tierSchema = z.coerce.number().int().min(1).max(PASS_TIERS);

@Controller("admin/pass/seasons")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminPassController {
  constructor(
    private readonly pass: PassAdminService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("pass.edit")
  async list(@Req() request: unknown): Promise<{ data: PassSeasonsView }> {
    return { data: await this.pass.seasons(accountOf(request)) };
  }

  @Get(":month")
  @RequirePermission("pass.edit")
  async get(@Req() request: unknown, @Param("month") month: string): Promise<{ data: PassSeasonView }> {
    return { data: await this.pass.season(accountOf(request), monthOf(month)) };
  }

  /** Завести ленту месяца: без `from` — по умолчанию, с `from` — копией того месяца. */
  @Post()
  @RequirePermission("pass.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: PassSeasonView }> {
    const actor = await this.consume(request);
    const input = parse(() => createSchema.parse(body), "Некорректный месяц пасса");
    return { data: await this.pass.create(actor, input) };
  }

  @Put(":month/tiers/:tier")
  @RequirePermission("pass.edit")
  async editTier(@Req() request: unknown, @Param("month") month: string, @Param("tier") tier: string, @Body() body: unknown): Promise<{ data: PassSeasonView }> {
    const actor = await this.consume(request);
    const key = monthOf(month);
    const number = parse(() => tierSchema.parse(tier), "Ступень — от 1 до 30");
    const edit = parse(() => tierEditSchema.parse(body), "Награда не проходит проверку: только монеты, самоцветы, осколки и буст, без случайного");
    return { data: await this.pass.editTier(actor, key, number, edit) };
  }

  @Post(":month/publish")
  @RequirePermission("pass.edit")
  async publish(@Req() request: unknown, @Param("month") month: string): Promise<{ data: PassSeasonView }> {
    const actor = await this.consume(request);
    return { data: await this.pass.publish(actor, monthOf(month)) };
  }

  private async consume(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}

function monthOf(value: string): string {
  return parse(() => monthSchema.parse(value), "Месяц — вида ГГГГ-ММ");
}
