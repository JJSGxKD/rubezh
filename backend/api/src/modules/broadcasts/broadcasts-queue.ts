import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { UnavailableError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { BROADCAST_RULES } from "./broadcast-rules.js";
import { BroadcastSender } from "./broadcast-sender.js";
import { BROADCASTS_REPOSITORY, type BroadcastsRepository } from "./broadcasts.repository.js";

/**
 * Очередь рассылок (docs/29-admin-panel.md §7.3). Задание — одна пачка
 * одной рассылки; после неё задание ставит следующую, с паузой, если
 * площадка попросила подождать.
 *
 * Темп общий на все рассылки и реплики: лимитер BullMQ живёт в Redis и
 * пропускает одну пачку за `batchSec` на всю очередь, а внутри пачки
 * сообщения идут в темпе площадки. Две рассылки разом делят темп, а не
 * удваивают его.
 *
 * Идущие рассылки поднимаются после перезапуска. Лишнее задание той же
 * рассылки безопасно: получателей берут со сроком захвата, и одну строку два
 * задания не возьмут.
 */

const QUEUE_NAME = "broadcasts";
const ENQUEUE_TIMEOUT_MS = 2_000;
const JOB_OPTIONS = { attempts: 3, backoff: { type: "exponential", delay: 5_000, jitter: 0.5 }, removeOnComplete: 1000, removeOnFail: 1000 } as const;

interface BroadcastJob {
  broadcastId: string;
}

@Injectable()
export class BroadcastsQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("broadcasts");
  private queue: Queue<BroadcastJob> | null = null;
  private worker: Worker<BroadcastJob> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BROADCASTS_REPOSITORY) private readonly broadcasts: BroadcastsRepository,
    private readonly sender: BroadcastSender,
  ) {}

  /** Рассылкам нужна база с аккаунтами — без входа игроков её нет. */
  get enabled(): boolean {
    return this.config.auth.enabled;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
      connection: consumer,
      concurrency: 1,
      limiter: { max: 1, duration: BROADCAST_RULES.batchSec * 1000 },
    });
    this.worker.on("failed", (job, error) => {
      if (job === undefined) return;
      this.log("warn", "broadcast_batch_failed", { broadcastId: job.data.broadcastId, attempts: job.attemptsMade, reason: error.message });
    });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
    // Не блокирует старт: база может быть ещё не готова, рассылка подождёт
    // следующего перезапуска или «продолжить» в панели.
    void this.resumeSending();
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  /** Поставить следующую пачку рассылки. Очереди нет — `UnavailableError`: панель скажет, что отправка не пошла. */
  async kick(broadcastId: string, delaySec = 0): Promise<void> {
    if (this.queue === null) throw new UnavailableError("Очередь рассылок недоступна");
    await withTimeout(this.queue.add("batch", { broadcastId }, { jobId: `${broadcastId}-${randomUUID()}`, delay: delaySec * 1000, ...JOB_OPTIONS }), ENQUEUE_TIMEOUT_MS, "очередь рассылок");
  }

  /** Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. */
  async process(job: Pick<Job<BroadcastJob>, "data">): Promise<void> {
    const outcome = await this.sender.sendBatch(job.data.broadcastId);
    if (outcome.kind === "continue") await this.kick(job.data.broadcastId);
    if (outcome.kind === "wait") await this.kick(job.data.broadcastId, outcome.afterSec);
  }

  private async resumeSending(): Promise<void> {
    try {
      for (const broadcastId of await this.broadcasts.sending()) await this.kick(broadcastId);
    } catch (error: unknown) {
      this.log("warn", "broadcast_resume_failed", { reason: error instanceof Error ? error.message : "unknown" });
    }
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "broadcasts", event, ...fields }));
  }
}
