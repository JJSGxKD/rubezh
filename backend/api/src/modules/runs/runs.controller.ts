import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ZodError } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { difficultyQuerySchema, reviewLimitSchema, runFinishSchema, runStartSchema } from "./dto/runs.dto.js";
import { RUNS_LIMITS } from "./runs-limits.js";
import { RunsService, type FinishResult } from "./runs.service.js";
import { RunsViewService, type LeaderboardView, type ProfileView } from "./runs-view.service.js";
import type { ReviewRow } from "./runs.repository.js";

/**
 * Забеги под аккаунтом (docs/34-stage3-plan.md, WP4). В контроллере нет
 * логики — только разбор границы и форма ответа
 * (docs/15-engineering-standards.md §2.3). Всё под `AuthGuard`: забег
 * принадлежит аккаунту, а не установке.
 */
@Controller("runs")
@UseGuards(AuthGuard)
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly view: RunsViewService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post("start")
  async start(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { trusted: boolean } }> {
    const account = accountOf(request);
    await this.limit(RUNS_LIMITS.start, account.accountId);
    const start = parse(() => runStartSchema.parse(body), "Некорректный старт забега");
    return { data: await this.runs.start(account, start) };
  }

  @Post()
  async finish(@Req() request: unknown, @Body() body: unknown): Promise<{ data: FinishResult }> {
    const account = accountOf(request);
    await this.limit(RUNS_LIMITS.finish, account.accountId);
    const run = parse(() => runFinishSchema.parse(body), "Некорректный итог забега");
    return { data: await this.runs.finish(account, run) };
  }

  @Get("leaderboard")
  async leaderboard(@Req() request: unknown, @Query("difficulty") difficulty?: string): Promise<{ data: LeaderboardView }> {
    const parsed = parse(() => difficultyQuerySchema.parse(difficulty), "Неизвестная сложность");
    return { data: await this.view.leaderboardFor(accountOf(request).accountId, parsed) };
  }

  @Get("me")
  async me(@Req() request: unknown): Promise<{ data: ProfileView }> {
    return { data: await this.view.profile(accountOf(request).accountId) };
  }

  /** Очередь разбора: подозрительные и отклонённые забеги, свежие первыми. */
  @Get("review")
  @UseGuards(PermissionGuard)
  @RequirePermission("players.view")
  async review(@Query("limit") limit?: string): Promise<{ data: { runs: ReviewRow[] } }> {
    const parsed = parse(() => reviewLimitSchema.parse(limit ?? undefined), "Некорректный предел");
    return { data: { runs: await this.view.review(parsed) } };
  }

  /** Лимит — по аккаунту: за адресом мобильного оператора стоят сотни игроков. */
  private async limit(rule: RateLimit, accountId: string): Promise<void> {
    if (!(await this.limiter.consume(rule, accountId))) throw new RateLimitedError("Слишком много забегов — подождите");
  }
}

function parse<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ZodError) throw new ValidationError(message);
    throw error;
  }
}
