import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { PassCloseService } from "./pass-close.service.js";

/**
 * Расписание закрытия месяца пасса (tasks/T-0312): повторяющееся задание BullMQ
 * раз в минуту, чтобы награды прошлого месяца ложились в первую минуту нового
 * по Москве. Планировщик с одним id идемпотентен — перезапуск и соседние
 * реплики не заводят второе расписание, а задание выполняет одна из них; это
 * первый слой защиты, замок Redis и ключи в базе — следующие
 * (`pass-close.service.ts`).
 *
 * Почти каждый проход — одно чтение меток закрытия по индексу первичного ключа.
 * Раз в минуту — 1440 заданий в сутки, поэтому выполненные и упавшие хранятся
 * только последние 24: BullMQ по умолчанию не удаляет ничего, и список растил бы
 * память Redis.
 */

const QUEUE_NAME = "pass-close";
const SCHEDULER_ID = "every-minute";
const EVERY_MS = 60_000;
const KEPT_JOBS = 24;

@Injectable()
export class PassCloseJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("battle-pass");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly closing: PassCloseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async () => await this.closing.closeDue(new Date()), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "battle-pass", event: "pass_close_failed", reason: error.message })));
    // Без обработчика ошибка соединения воркера роняла бы процесс.
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "battle-pass", event: "pass_close_worker_error", reason: error.message })));
    try {
      await this.queue.upsertJobScheduler(SCHEDULER_ID, { every: EVERY_MS }, { name: "close", opts: { removeOnComplete: KEPT_JOBS, removeOnFail: KEPT_JOBS } });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "battle-pass", event: "pass_close_schedule_failed", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }
}
