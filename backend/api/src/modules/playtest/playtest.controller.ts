import { Body, Controller, Get, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RolesService } from "../roles/roles.service.js";
import { sessionReportSchema } from "./dto/session-report.dto.js";
import { accessFor, type PlaytestAccess } from "./playtest-access.js";
import { PlaytestService } from "./playtest.service.js";

/**
 * Отчёты о запуске и доступ к инструментам. Под сессией аккаунта, как
 * забеги: подпись запуска на каждом запросе больше не проверяется
 * (docs/34-stage3-plan.md, WP4). В контроллере нет логики — только разбор
 * границы и форма ответа (docs/15-engineering-standards.md §2.3).
 */
@Controller("playtest")
@UseGuards(AuthGuard)
export class PlaytestController {
  constructor(
    private readonly service: PlaytestService,
    private readonly roles: RolesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Выключенный плейтест отвечает 404, как любой выключенный эндпоинт. */
  @Post("sessions")
  async session(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { recorded: boolean } }> {
    if (!this.config.playtest.enabled) throw new DisabledError("Плейтест выключен");
    const report = parse(() => sessionReportSchema.parse(body), "Некорректные сведения о запуске");
    await this.service.recordSession(accountOf(request).accountId, report, Date.now());
    return { data: { recorded: true } };
  }

  /**
   * Что открыто игроку. Работает и после плейтеста: режим разработчика нужен
   * команде и тогда. Хранилище для ответа не нужно — недоступный Redis не
   * прячет от администратора его инструменты.
   */
  @Get("access")
  async access(@Req() request: unknown): Promise<{ data: PlaytestAccess }> {
    return { data: await accessFor(accountOf(request), this.config, this.roles) };
  }
}

/**
 * Данные с границы системы парсятся схемой, а не приводятся через `as`
 * (CLAUDE.md, «Стиль кода»).
 */
function parse<T>(run: () => T, message: string): T {
  try {
    return run();
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      throw new ValidationError(`${message}: ${first.path.join(".")} — ${first.message}`);
    }
    throw error;
  }
}
