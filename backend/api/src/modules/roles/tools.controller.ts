import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { ToolsAccessService, type ToolsAccess } from "./tools-access.js";

/**
 * Инструменты команды в клиенте (docs/28-diagnostics.md §2.3): что открыто
 * спрашивающему. Своё — всегда, права на вопрос не нужно; ответ решается
 * правом `tools.dev` и настройкой «Стресс-тест для всех игроков».
 */
@Controller("tools")
export class ToolsController {
  constructor(private readonly tools: ToolsAccessService) {}

  @Get("access")
  @UseGuards(AuthGuard)
  async access(@Req() request: unknown): Promise<{ data: ToolsAccess }> {
    return { data: await this.tools.forAccount(accountOf(request)) };
  }
}
