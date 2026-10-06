import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { networkTaskSchema } from "../tasks/network-task-rules.js";
import { NetworkTasksService, type NetworkTaskAdminView } from "../tasks/network-tasks.service.js";
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
 *
 * Задания рекламных сетей (WP13, часть 6) — строкой на сеть рядом с
 * каталогом: потолок в сутки, пауза, награда, включено — и что ещё нужно,
 * чтобы игроки их увидели.
 */
@Controller("admin/tasks")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminTasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly networks: NetworkTasksService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission("tasks.edit")
  async list(@Req() request: unknown): Promise<{ data: TaskCatalogView & { networks: NetworkTaskAdminView[] } }> {
    const actor = accountOf(request);
    const [catalog, networks] = await Promise.all([this.tasks.catalog(actor), this.networks.catalog(actor)]);
    return { data: { ...catalog, networks } };
  }

  @Post()
  @RequirePermission("tasks.edit")
  async save(@Req() request: unknown, @Body() body: unknown): Promise<{ data: TaskDef }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const task = parse(() => taskDefSchema.parse(body), "Некорректное задание");
    return { data: await this.tasks.save(actor, task) };
  }

  /** Строка заданий сети: ключ сети — из адреса, числа — из тела. */
  @Post("networks/:networkKey")
  @RequirePermission("tasks.edit")
  async saveNetwork(@Req() request: unknown, @Param("networkKey") networkKey: string, @Body() body: unknown): Promise<{ data: NetworkTaskAdminView }> {
    const actor = accountOf(request);
    await this.limit(actor.accountId);
    const def = parse(() => networkTaskSchema.parse({ ...z.record(z.string(), z.unknown()).parse(body), networkKey }), "Некорректная строка заданий сети");
    return { data: await this.networks.save(actor, def) };
  }

  private async limit(accountId: string): Promise<void> {
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
  }
}
