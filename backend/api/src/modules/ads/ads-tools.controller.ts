import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ForbiddenError, RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { RolesService } from "../roles/roles.service.js";
import { ADS_TOOLS_LIMITS } from "./ads-tools-limits.js";
import { AdsToolsService, toolsAdsResultSchema, type ToolsAdsCatalog } from "./ads-tools.service.js";

/**
 * Проверка рекламы командой (docs/35-stage4-plan.md, Р165; tasks/T-0333): каталог
 * SDK-сетей и блоков и приём исхода проверки для экрана «Проверка рекламы».
 * Право — `tools.dev`, проверка на сервере: скрытая кнопка не защита. Порядок
 * везде один: лимит частоты, право, разбор тела, дело.
 */
@Controller("tools/ads")
export class AdsToolsController {
  constructor(
    private readonly tools: AdsToolsService,
    private readonly roles: RolesService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get("catalog")
  @UseGuards(AuthGuard)
  async catalog(@Req() request: unknown): Promise<{ data: ToolsAdsCatalog }> {
    await this.admit(request, ADS_TOOLS_LIMITS.catalog);
    return { data: await this.tools.catalog() };
  }

  @Post("test-results")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async testResult(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { ok: true } }> {
    const account = await this.admit(request, ADS_TOOLS_LIMITS.result);
    const parsed = toolsAdsResultSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Некорректный результат проверки");
    await this.tools.recordResult(account, parsed.data);
    return { data: { ok: true } };
  }

  private async admit(request: unknown, limit: RateLimit): Promise<ReturnType<typeof accountOf>> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(limit, account.accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
    if (!(await this.roles.can(account, "tools.dev"))) throw new ForbiddenError("Недостаточно прав");
    return account;
  }
}
