import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { UnavailableError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { EVENTS_REPOSITORY, type EventRow, type EventsRepository } from "./events.repository.js";

/**
 * Куда уходит принятая пачка (docs/22-analytics-and-metrics.md §3.2): в
 * очередь BullMQ, а воркер пишет её в Postgres одной вставкой. Ответ игроку не
 * ждёт базу.
 *
 * Redis недоступен — пачка пишется в базу напрямую: «при недоступном Redis игра
 * не замечает проблем» (docs/26-stage2-plan.md, WP8). Недоступно и то и
 * другое — `503`, и клиент оставляет пачку у себя до следующей попытки: потеря
 * события — деградация, удвоение — нет, а повтор отсекает event_id.
 */
export const EVENTS_SINK = Symbol("EVENTS_SINK");

export interface EventsSink {
  write(rows: readonly EventRow[]): Promise<void>;
}

const QUEUE_NAME = "events";
/** Сколько ждать постановки в очередь, прежде чем писать в базу напрямую. */
const ENQUEUE_TIMEOUT_MS = 2_000;
const WORKER_CONCURRENCY = 2;
/** Сбой Redis повторяется на каждом запросе и переподключении — в лог не чаще раза в минуту. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

@Injectable()
export class QueuedEventsSink implements EventsSink, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("events");
  private queue: Queue<{ rows: EventRow[] }> | null = null;
  private worker: Worker<{ rows: EventRow[] }> | null = null;
  private connections: Redis[] = [];
  private readonly lastLoggedAt = new Map<string, number>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EVENTS_REPOSITORY) private readonly repository: EventsRepository,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.ingest.eventsEnabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async (job) => this.repository.insertMany(job.data.rows), {
      connection: consumer,
      concurrency: WORKER_CONCURRENCY,
    });
    this.worker.on("failed", (job, error) => {
      this.log("warn", "batch_write_failed", { attempts: job?.attemptsMade ?? 0, reason: error.message });
    });
    // Без обработчика ошибка соединения воркера роняла бы процесс.
    this.worker.on("error", (error) => this.logThrottled("worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  async write(rows: readonly EventRow[]): Promise<void> {
    if (rows.length === 0) return;
    if (this.queue !== null && (await this.enqueue(this.queue, rows))) return;
    try {
      await this.repository.insertMany(rows);
    } catch (error: unknown) {
      this.log("error", "direct_write_failed", { rows: rows.length, reason: reasonOf(error) });
      throw new UnavailableError("Приём событий временно недоступен");
    }
  }

  private async enqueue(queue: Queue<{ rows: EventRow[] }>, rows: readonly EventRow[]): Promise<boolean> {
    try {
      await withTimeout(
        queue.add(
          "batch",
          { rows: [...rows] },
          {
            attempts: 5,
            backoff: { type: "exponential", delay: 2_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000,
          },
        ),
        ENQUEUE_TIMEOUT_MS,
        "очередь событий",
      );
      return true;
    } catch (error: unknown) {
      this.logThrottled("enqueue_failed", { reason: reasonOf(error) });
      return false;
    }
  }

  private logThrottled(event: string, fields: Record<string, unknown>): void {
    const now = Date.now();
    if (now - (this.lastLoggedAt.get(event) ?? 0) < FAILURE_LOG_INTERVAL_MS) return;
    this.lastLoggedAt.set(event, now);
    this.log("warn", event, fields);
  }

  private log(level: "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "events", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
