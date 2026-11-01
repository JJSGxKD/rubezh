import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { UnavailableError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { NameRulesRecleanService, type RecleanEnqueuer, type RecleanJobData } from "./name-rules-reclean.service.js";

/**
 * Очередь перечистки ников (tasks/T-0339): одно задание за раз и без
 * автоповтора — повтор записывающего прохода после сбоя решает человек.
 * Сервис получает воркер лениво через `ModuleRef`: сервис ставит задания,
 * воркер вызывает сервис, и прямые зависимости друг от друга замкнули бы круг.
 */

const QUEUE_NAME = "name-rules-reclean";
const ENQUEUE_TIMEOUT_MS = 2_000;

@Injectable()
export class RecleanQueue implements RecleanEnqueuer, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("name-rules");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly modules: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.databaseUrl === "") return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    const service = this.modules.get(NameRulesRecleanService, { strict: false });
    this.worker = new Worker(QUEUE_NAME, async (job) => await service.process(job.data as RecleanJobData), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "name-rules", event: "reclean_job_failed", reason: error.name })));
    // Без обработчика ошибка соединения воркера роняла бы процесс.
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "name-rules", event: "reclean_worker_error", reason: error.name })));
  }

  async enqueue(data: RecleanJobData): Promise<void> {
    if (this.queue === null) throw new UnavailableError("Очередь недоступна — попробуйте позже");
    try {
      await withTimeout(this.queue.add("reclean", data, { attempts: 1, removeOnComplete: 20, removeOnFail: 20 }), ENQUEUE_TIMEOUT_MS, "перечистка: постановка в очередь");
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "reclean_not_queued", reason: error instanceof Error ? error.name : "unknown" }));
      throw new UnavailableError("Очередь недоступна — попробуйте позже");
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }
}
