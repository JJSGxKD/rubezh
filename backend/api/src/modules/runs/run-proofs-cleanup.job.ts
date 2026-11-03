import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { RunProofsService } from "./run-proofs.service.js";

/**
 * Очистка записей забегов для проверки (tasks/T-0317): раз в час повторяющееся
 * задание BullMQ удаляет просроченные пачками по 1 000 (`RunProofsService.cleanup`).
 * Планировщик с одним id идемпотентен — перезапуск и соседние реплики не заводят
 * второе расписание, а задание выполняет одна из них; повторный запуск
 * безопасен: удалять нечего — выход.
 */

const QUEUE_NAME = "run-proofs-cleanup";
const SCHEDULER_ID = "hourly";
const EVERY_MS = 3_600_000;

@Injectable()
export class RunProofsCleanupJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("run-proofs");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly proofs: RunProofsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async () => await this.proofs.cleanup(), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "runs", event: "run_proofs_cleanup_failed", reason: error.name })));
    // Без обработчика ошибка соединения воркера роняла бы процесс.
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "runs", event: "run_proofs_worker_error", reason: error.name })));
    try {
      await this.queue.upsertJobScheduler(SCHEDULER_ID, { every: EVERY_MS }, { name: "cleanup", opts: { removeOnComplete: 24, removeOnFail: 24 } });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "runs", event: "run_proofs_schedule_failed", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }
}
