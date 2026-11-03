import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { NAME_RULE_CATEGORIES, NAME_RULE_KINDS, NAME_RULE_LIMITS } from "../name-rules/name-rules-limits.js";
import { NameRulesService, type NameRuleView, type NameRulesView, type ProbeResult } from "../name-rules/name-rules.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Правила фильтра имён в панели (docs/29-admin-panel.md, раздел «Фильтр имён»;
 * docs/35-stage4-plan.md, Р168). Кто видит экран, тот и правит: право одно —
 * `names.edit`. Длину шаблона и опасную регулярку проверяет сервис — у него
 * для этого русская причина; схема держит форму тела.
 */
const categorySchema = z.enum(NAME_RULE_CATEGORIES);
const kindSchema = z.enum(NAME_RULE_KINDS);
const patternSchema = z.string().max(NAME_RULE_LIMITS.patternMax * 4);
const noteSchema = z.string().max(NAME_RULE_LIMITS.noteMax * 4).nullable();

const createSchema = z.strictObject({ category: categorySchema, kind: kindSchema, pattern: patternSchema, active: z.boolean().optional(), note: noteSchema.optional() });
const patchSchema = createSchema
  .partial()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: "Нужно хотя бы одно поле" });
const probeSchema = z.strictObject({
  ruleId: z.string().uuid().optional(),
  category: categorySchema,
  kind: kindSchema,
  pattern: patternSchema,
  samples: z.array(z.string()).max(NAME_RULE_LIMITS.samplesMax * 4),
});
const idSchema = z.string().uuid();

@Controller("admin/name-rules")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminNameRulesController {
  constructor(
    private readonly rules: NameRulesService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("names.edit")
  async view(@Req() request: unknown): Promise<{ data: NameRulesView }> {
    return { data: await this.rules.view(accountOf(request)) };
  }

  @Post()
  @RequirePermission("names.edit")
  async create(@Req() request: unknown, @Body() body: unknown): Promise<{ data: NameRuleView }> {
    const actor = await this.mutating(request);
    return { data: await this.rules.create(actor, parse(() => createSchema.parse(body), "Некорректное правило")) };
  }

  @Patch(":ruleId")
  @RequirePermission("names.edit")
  async update(@Req() request: unknown, @Param("ruleId") ruleId: string, @Body() body: unknown): Promise<{ data: NameRuleView }> {
    const actor = await this.mutating(request);
    const id = parse(() => idSchema.parse(ruleId), "Некорректный номер правила");
    return { data: await this.rules.update(actor, id, parse(() => patchSchema.parse(body), "Некорректное правило")) };
  }

  @Delete(":ruleId")
  @RequirePermission("names.edit")
  async remove(@Req() request: unknown, @Param("ruleId") ruleId: string): Promise<{ data: { removed: true } }> {
    const actor = await this.mutating(request);
    await this.rules.remove(actor, parse(() => idSchema.parse(ruleId), "Некорректный номер правила"));
    return { data: { removed: true } };
  }

  /** Проверка на примерах: POST ради тела, но ничего не создаёт — поэтому 200, а не 201. */
  @Post("test")
  @HttpCode(200)
  @RequirePermission("names.edit")
  async test(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { results: ProbeResult[] } }> {
    const actor = await this.mutating(request);
    const input = parse(() => probeSchema.parse(body), "Некорректная проверка");
    return { data: { results: await this.rules.probe(actor, input) } };
  }

  private async mutating(request: unknown): Promise<ReturnType<typeof accountOf>> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
