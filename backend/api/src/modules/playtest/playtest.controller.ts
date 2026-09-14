import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { ValidationError } from "../../common/domain-error";
import { difficultyQuerySchema, runSubmissionSchema } from "./dto/run-submission.dto";
import { PlaytestAuthGuard, playerOf } from "./playtest-auth.guard";
import {
  PlaytestService,
  type LeaderboardView,
  type ProfileView,
  type SubmitResult,
} from "./playtest.service";

/**
 * Сохранения и лидерборд плейтеста. В контроллере нет логики — только разбор
 * границы и форма ответа (docs/15-engineering-standards.md §2.3).
 */
@Controller("playtest")
@UseGuards(PlaytestAuthGuard)
export class PlaytestController {
  constructor(private readonly service: PlaytestService) {}

  @Post("runs")
  async submit(@Req() request: unknown, @Body() body: unknown): Promise<{ data: SubmitResult }> {
    const submission = parse(() => runSubmissionSchema.parse(body), "Некорректный итог забега");
    return { data: await this.service.submitRun(playerOf(request), submission, Date.now()) };
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
