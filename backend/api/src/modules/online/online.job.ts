import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { OnlineService } from "./online.service.js";

/**
 * Пересчёт онлайна раз в 15 с (Р107). Повторяющееся задание BullMQ с
 * постоянным id выпускает одно задание на тик на все реплики API — это и
 * есть распределённый лок: цифра у всех одна, а Redis не считают N раз.
 */

const QUEUE_NAME = "online";
const EVERY_MS = 15_000;

@Injectable()
export class OnlineJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("online");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly online: OnlineService,
  ) {}

  /** Включено там же, где остальные задания: нужна база, которой живёт приложение. */
  get enabled(): boolean {
    return this.config.databaseUrl !== "";
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async () => void (await this.online.recount(new Date())), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "online", event: "recount_failed", reason: error.message })));
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "online", event: "worker_error", reason: error.message })));
    try {
      // Планировщик с тем же id идемпотентен: перезапуск и соседние реплики не заводят второе расписание.
      await this.queue.upsertJobScheduler("recount", { every: EVERY_MS }, { name: "recount" });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "online", event: "schedule_failed", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }
}
