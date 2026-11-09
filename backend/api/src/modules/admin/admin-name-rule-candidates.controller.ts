import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { NameRuleCandidatesAdminService, type CandidatesView } from "../name-rules/name-rule-candidates.service.js";
import { NAME_RULE_CATEGORIES } from "../name-rules/name-rules-limits.js";
import type { NameRuleView } from "../name-rules/name-rules.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Кандидаты в правила фильтра имён в панели (Р168, tasks/T-0341): частые слова
 * и пары слов из ночного расчёта. Право — `names.edit`, как у самих правил.
 * «В стирания» и «в исключения» — `accept`: слово становится обычным правилом
 * через `NameRulesService.create`, с теми же проверками, лимитами и аудитом;
 * «не нужно» — `dismiss`. Вид правила для слова — слово целиком или точная
 * фраза: регулярку по слову из расчёта не заводим.
 */
const acceptSchema = z.strictObject({ category: z.enum(NAME_RULE_CATEGORIES), kind: z.enum(["exact", "word"]) });
const idSchema = z.string().uuid();

@Controller("admin/name-rules/candidates")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminNameRuleCandidatesController {
  constructor(
    private readonly candidates: NameRuleCandidatesAdminService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("names.edit")
  async list(@Req() request: unknown): Promise<{ data: CandidatesView }> {
    return { data: await this.candidates.list(accountOf(request)) };
  }

  @Post(":candidateId/accept")
  @RequirePermission("names.edit")
  async accept(@Req() request: unknown, @Param("candidateId") candidateId: string, @Body() body: unknown): Promise<{ data: NameRuleView }> {
    const actor = await this.mutating(request);
    const id = parse(() => idSchema.parse(candidateId), "Некорректный номер кандидата");
    const input = parse(() => acceptSchema.parse(body), "Нужны категория и вид правила: слово целиком или точная фраза");
    return { data: await this.candidates.accept(actor, id, input) };
  }

  /** Ничего не создаёт — скрывает: поэтому 200, а не 201. */
  @Post(":candidateId/dismiss")
  @HttpCode(200)
  @RequirePermission("names.edit")
  async dismiss(@Req() request: unknown, @Param("candidateId") candidateId: string): Promise<{ data: { dismissed: true } }> {
    const actor = await this.mutating(request);
    const id = parse(() => idSchema.parse(candidateId), "Некорректный номер кандидата");
    return { data: await this.candidates.dismiss(actor, id) };
  }

  private async mutating(request: unknown) {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
