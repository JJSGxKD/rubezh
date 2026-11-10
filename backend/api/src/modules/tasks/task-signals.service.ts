import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { AccountRef } from "../roles/roles.service.js";
import type { ClientKind } from "./client-signal-rules.js";
import { TaskNotFoundError } from "./tasks-errors.js";
import { TASKS_REPOSITORY, type TasksRepository } from "./tasks.repository.js";
import { TasksService, type TaskView } from "./tasks.service.js";

const DB_TIMEOUT_MS = 3_000;

/**
 * Сигнал клиента о действии, которое сервер проверить не может (Р187, T-0375):
 * игру добавили на главный экран, открыт редактор истории. Выполняет текущий
 * срок заданий этого вида; награда — обычным забором, поэтому фермить нечего:
 * срок задания и лимит частоты маршрута ограничивают повтор.
 *
 * Идемпотентность — у `repository.complete`: выполнение срока записывается
 * однажды, повтор и гонка дают ту же строку прогресса.
 */
@Injectable()
export class TaskSignalsService {
  private readonly logger = new Logger("tasks");

  constructor(
    private readonly tasks: TasksService,
    @Inject(TASKS_REPOSITORY) private readonly repository: TasksRepository,
  ) {}

  async signal(account: AccountRef, kind: ClientKind, at = new Date()): Promise<{ tasks: TaskView[] }> {
    const matching = (await this.tasks.view(account, at)).filter((task) => task.kind === kind);
    // Задания этого вида у игрока нет — выключено в панели или не заведено.
    if (matching.length === 0) throw new TaskNotFoundError();
    const pending = matching.filter((task) => !task.done);
    if (pending.length === 0) return { tasks: await this.tasks.view(account, at) };
    for (const task of pending) {
      // Лимита у этих видов нет, место не занимается: `at` вместо начала мягкого часа.
      await withTimeout(this.repository.complete(account.accountId, { taskId: task.id, period: task.period, target: task.target }, at, at), DB_TIMEOUT_MS, "задания");
      this.logger.log(JSON.stringify({ module: "tasks", event: "task_signal", accountId: account.accountId, taskId: task.id, kind }));
    }
    return { tasks: await this.tasks.view(account, at) };
  }
}
