import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { ROLES_LIMITS } from "./roles-limits.js";
import { ToolsAccessService, type ToolsAccess } from "./tools-access.js";

/**
 * Инструменты команды в клиенте (docs/28-diagnostics.md §2.3): что открыто
 * спрашивающему. Своё — всегда, права на вопрос не нужно; ответ решается
 * правом `tools.dev` и настройкой «Стресс-тест для всех игроков».
 */
@Controller("tools")
export class ToolsController {
  constructor(
    private readonly tools: ToolsAccessService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get("access")
  @UseGuards(AuthGuard)
  async access(@Req() request: unknown): Promise<{ data: ToolsAccess }> {
    const account = accountOf(request);
    if (!(await this.limiter.consume(ROLES_LIMITS.toolsAccess, account.accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
    return { data: await this.tools.forAccount(account) };
  }
}
