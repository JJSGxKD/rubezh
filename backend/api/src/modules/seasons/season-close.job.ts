import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { SeasonsCloseService } from "./seasons-close.service.js";

/**
 * Расписание закрытия сезонов (tasks/T-0110): повторяющееся задание BullMQ раз
 * в 15 минут. Планировщик с одним id идемпотентен — перезапуск и соседние
 * реплики не заводят второе расписание, а задание выполняет одна из них; это
 * первый слой защиты, лок и ключ в базе — следующие (`seasons-close.service.ts`).
 *
 * Пока `seasons.start-date` пуст, каждый проход — одно чтение настройки.
 */

const QUEUE_NAME = "seasons-close";
const SCHEDULER_ID = "every-15-min";
const EVERY_MS = 15 * 60_000;

@Injectable()
export class SeasonCloseJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("seasons");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly closing: SeasonsCloseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async () => await this.closing.closeDue(new Date()), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "seasons", event: "close_failed", reason: error.message })));
    // Без обработчика ошибка соединения воркера роняла бы процесс.
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "seasons", event: "worker_error", reason: error.message })));
    try {
      await this.queue.upsertJobScheduler(SCHEDULER_ID, { every: EVERY_MS }, { name: "close" });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "seasons", event: "schedule_failed", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }
}
