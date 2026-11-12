import { withTimeout } from "../../common/with-timeout.js";
import type { TasksRepository } from "../../modules/tasks/tasks.repository.js";

/**
 * Ссылки на каналы MAX для ответа бота (docs/35-stage4-plan.md Р188,
 * tasks/T-0379): адрес канала — `params.url` включённого задания «подписаться на
 * канал» с площадкой `max`. Бот читает каталог при каждом ответе: ответов
 * немного (по одному на связанного игрока), а правка задания в панели должна
 * действовать сразу.
 */

const DB_TIMEOUT_MS = 3_000;

export class MaxChannelLinks {
  constructor(private readonly tasks: Pick<TasksRepository, "catalog">) {}

  /** Адреса каналов в порядке каталога, без повторов. */
  async urls(): Promise<readonly string[]> {
    const defs = await withTimeout(this.tasks.catalog(), DB_TIMEOUT_MS, "каталог заданий");
    const urls = defs.filter((def) => def.active && def.kind === "channel" && def.params?.platform === "max").flatMap((def) => (def.params === null ? [] : [def.params.url]));
    return [...new Set(urls)];
  }
}
