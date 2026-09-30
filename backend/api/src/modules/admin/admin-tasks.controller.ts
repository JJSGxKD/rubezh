import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { taskDefSchema, type TaskDef } from "../tasks/task-rules.js";
import { TasksService, type TaskCatalogView } from "../tasks/tasks.service.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/**
 * Каталог заданий и достижений в панели (docs/35-stage4-plan.md Р52, WP13):
 * цели, награды, текст и включённость без релиза — под `tasks.edit`, каждое
 * изменение — в аудит. Удаления нет: задание выключают, на него ссылается
 * прогресс игроков.
 */
@Controller("admin/tasks")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminTasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("tasks.edit")
  async list(@Req() request: unknown): Promise<{ data: TaskCatalogView }> {
    return { data: await this.tasks.catalog(accountOf(request)) };
  }

  @Post()
  @RequirePermission("tasks.edit")
  async save(@Req() request: unknown, @Body() body: unknown): Promise<{ data: TaskDef }> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    const task = parse(() => taskDefSchema.parse(body), "Некорректное задание");
    return { data: await this.tasks.save(actor, task) };
  }
}
