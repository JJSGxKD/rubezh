import { Controller, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { AuthGuard, accountOf } from "../auth/auth.guard.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { SIGNAL_LIMIT, isClientKind } from "./client-signal-rules.js";
import { TaskSignalsService } from "./task-signals.service.js";
import type { TaskView } from "./tasks.service.js";

/**
 * `POST /api/v1/tasks/signals/:kind` (Р187, T-0375): клиент сообщает о
 * действии, которое сервер проверить не может, — игру добавили на главный экран,
 * открыт редактор истории. Тело не читается: клиент не вправе ничего добавить к
 * сигналу. Награду игрок забирает обычным `POST /tasks/:taskId/claim`.
 */
@Controller("tasks")
@UseGuards(AuthGuard)
export class TaskSignalsController {
  constructor(
    private readonly signals: TaskSignalsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post("signals/:kind")
  @HttpCode(200)
  async signal(@Req() request: unknown, @Param("kind") kind: string): Promise<{ data: { tasks: TaskView[] } }> {
    const account = accountOf(request);
    if (!isClientKind(kind)) throw new ValidationError("Неизвестное действие");
    if (!(await this.limiter.consume(SIGNAL_LIMIT, account.accountId))) throw new RateLimitedError("Слишком часто — попробуй позже");
    return { data: await this.signals.signal(account, kind) };
  }
}
