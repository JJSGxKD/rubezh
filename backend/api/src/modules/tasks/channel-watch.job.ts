import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { TICK_MS } from "./channel-watch-rules.js";
import { ChannelWatchService } from "./channel-watch.service.js";

/**
 * Перепроверка подписки после награды по расписанию (docs/35-stage4-plan.md
 * Р115, tasks/T-0178): раз в `TICK_MS` проход берёт окна, чей срок проверки
 * наступил. Повторяющееся задание BullMQ с постоянным id выполняется одной из
 * реплик API — это и есть распределённый лок крон-задачи
 * (docs/15-engineering-standards.md §4.3); от двойной работы на одной паре
 * защищает ещё и замок пары в самом проходе.
 */

const QUEUE_NAME = "channel-watch";

@Injectable()
export class ChannelWatchJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("tasks");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly service: ChannelWatchService,
  ) {}

  /** Включено, когда есть база: без неё нет ни окон, ни кому их проверять. */
  get enabled(): boolean {
    return this.config.databaseUrl !== "";
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async () => await this.service.tick(new Date()), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.error(JSON.stringify({ module: "tasks", event: "channel_watch_tick_failed", reason: error.message })));
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "tasks", event: "channel_watch_worker_error", reason: error.message })));
    try {
      // Планировщик с тем же id идемпотентен: перезапуск и соседние реплики не заводят второе расписание.
      await this.queue.upsertJobScheduler("tick", { every: TICK_MS }, { name: "tick" });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "tasks", event: "channel_watch_schedule_failed", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }
}
