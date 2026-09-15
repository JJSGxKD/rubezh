import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { accessFor, isAdmin, type PlaytestAccess } from "./playtest-access.js";
import { ValidationError } from "../../common/domain-error.js";
import {
  difficultyQuerySchema,
  runSubmissionSchema,
  sessionReportSchema,
} from "./dto/run-submission.dto.js";
import { PlaytestAuthGuard, playerOf } from "./playtest-auth.guard.js";
import {
  PlaytestService,
  type LeaderboardView,
  type ProfileView,
  type SubmitResult,
} from "./playtest.service.js";

/**
 * Сохранения и лидерборд плейтеста. В контроллере нет логики — только разбор
 * границы и форма ответа (docs/15-engineering-standards.md §2.3).
 */
@Controller("playtest")
@UseGuards(PlaytestAuthGuard)
export class PlaytestController {
  constructor(
    private readonly service: PlaytestService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post("runs")
  async submit(@Req() request: unknown, @Body() body: unknown): Promise<{ data: SubmitResult }> {
    const submission = parse(() => runSubmissionSchema.parse(body), "Некорректный итог забега");
    const player = playerOf(request);
    return { data: await this.service.submitRun(player, submission, Date.now(), isAdmin(player, this.config)) };
  }

  @Post("sessions")
  async session(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { recorded: boolean } }> {
    const report = parse(() => sessionReportSchema.parse(body), "Некорректные сведения о запуске");
    await this.service.recordSession(playerOf(request), report, Date.now());
    return { data: { recorded: true } };
  }

  @Get("leaderboard")
  async leaderboard(
    @Req() request: unknown,
    @Query("difficulty") difficulty?: string,
  ): Promise<{ data: LeaderboardView }> {
    const parsed = parse(() => difficultyQuerySchema.parse(difficulty), "Неизвестная сложность");
    return { data: await this.service.leaderboard(playerOf(request).id, parsed) };
  }

  @Get("me")
  async me(@Req() request: unknown): Promise<{ data: ProfileView }> {
    return { data: await this.service.profile(playerOf(request).id) };
  }

  /**
   * Что открыто игроку. Отдельно от профиля: хранилище для ответа не нужно,
   * и недоступный Redis не должен прятать от администратора его инструменты.
   */
  @Get("access")
  access(@Req() request: unknown): { data: PlaytestAccess } {
    return { data: accessFor(playerOf(request), this.config) };
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
