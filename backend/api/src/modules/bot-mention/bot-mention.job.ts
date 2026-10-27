import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { SWEEP_INTERVAL_MS } from "./bot-mention-rules.js";
import { BotMentionSweepService } from "./bot-mention-sweep.service.js";

/**
 * Расписание ночного прохода заданий «юзернейм бота» (tasks/T-0162):
 * повторяющееся задание BullMQ раз в пять минут. Планировщик с одним id
 * идемпотентен — перезапуск и соседние реплики не заводят второе расписание,
 * а задание выполняет одна из них; лок и пауза в Redis — следующие слои
 * защиты (`bot-mention-sweep.service.ts`).
 *
 * Пока функция выключена в панели, каждый проход — чтение настроек и выход.
 */

const QUEUE_NAME = "bot-mention";
const SCHEDULER_ID = "every-5-min";

@Injectable()
export class BotMentionJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("bot-mention");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sweep: BotMentionSweepService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async () => await this.sweep.run(), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "bot-mention", event: "sweep_failed", reason: error.name })));
    // Без обработчика ошибка соединения воркера роняла бы процесс.
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "bot-mention", event: "worker_error", reason: error.name })));
    try {
      // Завершённые задания не копятся в Redis: проход идёт круглые сутки.
      await this.queue.upsertJobScheduler(SCHEDULER_ID, { every: SWEEP_INTERVAL_MS }, { name: "sweep", opts: { removeOnComplete: 100, removeOnFail: 100 } });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "bot-mention", event: "schedule_failed", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }
}
