import { setTimeout as sleep } from "node:timers/promises";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { createQueueConnection } from "../../infra/queues.js";

/**
 * Срок хранения сырых событий и отчётов — `DIAGNOSTICS_RETENTION_DAYS`, 90 дней
 * (docs/28-diagnostics.md §5.4). Очистка — повторяющееся задание BullMQ раз в
 * час: при нескольких репликах API оно выполняется одной из них, это и есть
 * распределённый лок (docs/15-engineering-standards.md §4.3).
 *
 * Удаление — пачками по ключу, а не одним DELETE на миллионы строк: долгая
 * транзакция держала бы блокировки на таблице, в которую идёт приём.
 */

const QUEUE_NAME = "retention";
const EVERY_MS = 60 * 60 * 1000;
const BATCH = 5_000;
const BATCH_PAUSE_MS = 100;

export interface RetentionResult {
  events: number;
  reports: number;
}

@Injectable()
export class RetentionJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("retention");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  get enabled(): boolean {
    return this.config.databaseUrl !== "" && (this.config.ingest.eventsEnabled || this.config.ingest.reportsEnabled);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async () => this.purge(new Date()), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "retention", event: "purge_failed", reason: error.message })));
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "retention", event: "worker_error", reason: error.message })));
    try {
      // Планировщик с тем же id идемпотентен: перезапуск и соседние реплики не
      // заводят второе расписание.
      await this.queue.upsertJobScheduler("hourly", { every: EVERY_MS }, { name: "purge" });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "retention", event: "schedule_failed", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  async purge(now: Date): Promise<RetentionResult> {
    const cutoff = new Date(now.getTime() - this.config.ingest.retentionDays * 24 * 60 * 60 * 1000);
    const result: RetentionResult = { events: 0, reports: 0 };
    for (;;) {
      const deleted = await this.prisma.$executeRaw`DELETE FROM analytics_event WHERE event_id IN (SELECT event_id FROM analytics_event WHERE received_at < ${cutoff} LIMIT ${BATCH})`;
      result.events += deleted;
      if (deleted < BATCH) break;
      await sleep(BATCH_PAUSE_MS);
    }
    for (;;) {
      const deleted = await this.prisma.$executeRaw`DELETE FROM diagnostic_report WHERE report_id IN (SELECT report_id FROM diagnostic_report WHERE received_at < ${cutoff} LIMIT ${BATCH})`;
      result.reports += deleted;
      if (deleted < BATCH) break;
      await sleep(BATCH_PAUSE_MS);
    }
    if (result.events > 0 || result.reports > 0) {
      this.logger.log(JSON.stringify({ module: "retention", event: "purged", cutoff: cutoff.toISOString(), ...result }));
    }
    return result;
  }
}
