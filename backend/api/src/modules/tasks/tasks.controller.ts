import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter, type RateLimit } from "../ingest/rate-limiter.js";
import { TasksService, type TaskClaimResult, type TaskView } from "./tasks.service.js";

/**
 * Задания и достижения (`/api/v1/tasks`, docs/35-stage4-plan.md WP13): цели
 * с прогрессом и забор награды. Только своё — аккаунт из токена; что
 * выполнено, решает сервер по записанным забегам.
 */
const LIMIT: RateLimit = { scope: "tasks", limit: 300, windowSec: 3600 };
const TASK_ID = /^[a-z][a-z0-9_]{1,47}$/;

@Controller("tasks")
@UseGuards(AuthGuard)
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async view(@Req() request: unknown): Promise<{ data: { tasks: TaskView[] } }> {
    const { accountId } = accountOf(request);
    await this.limit(accountId);
    return { data: { tasks: await this.tasks.view(accountId) } };
  }

  @Post(":taskId/claim")
  @HttpCode(200)
  async claim(@Req() request: unknown, @Param("taskId") taskId: string): Promise<{ data: TaskClaimResult }> {
    const { accountId } = accountOf(request);
    if (!TASK_ID.test(taskId)) throw new ValidationError("Неверный id задания");
    await this.limit(accountId);
    return { data: await this.tasks.claim(accountId, taskId) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(LIMIT, accountId))) throw new RateLimitedError("Слишком часто — попробуйте позже");
  }
}
