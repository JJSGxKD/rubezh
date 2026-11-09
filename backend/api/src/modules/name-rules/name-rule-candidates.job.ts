import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { CANDIDATE_RULES } from "./name-rule-candidates-rules.js";
import { NameRuleCandidatesService } from "./name-rule-candidates.service.js";

/**
 * Расписание ночного расчёта кандидатов в правила имён (tasks/T-0341):
 * повторяющееся задание BullMQ раз в сутки. Планировщик с одним id идемпотентен —
 * перезапуск и соседние реплики не заводят второе расписание, а задание берёт
 * одна из них; замок в Redis (`name-rule-candidates.service.ts`) — следующий слой
 * защиты. Сбой расписания — предупреждение, а не падение сервера.
 */

const QUEUE_NAME = "name-rule-candidates";
const SCHEDULER_ID = "nightly";

@Injectable()
export class NameRuleCandidatesJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("name-rules");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly candidates: NameRuleCandidatesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async () => await this.candidates.run(), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "name-rules", event: "candidates_failed", reason: error.name })));
    // Без обработчика ошибка соединения воркера роняла бы процесс.
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "name-rules", event: "candidates_worker_error", reason: error.name })));
    try {
      await this.queue.upsertJobScheduler(
        SCHEDULER_ID,
        { pattern: CANDIDATE_RULES.schedule, tz: "UTC" },
        { name: "compute", opts: { attempts: 1, removeOnComplete: 10, removeOnFail: 10 } },
      );
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "candidates_schedule_failed", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }
}
