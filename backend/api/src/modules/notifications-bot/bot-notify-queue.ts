import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { NotificationsService, type CreatedNotification } from "../notifications/notifications.service.js";
import { BOT_NOTIFY_PER_SEC, botRuleOf } from "./bot-notify-rules.js";
import { BotNotifySender } from "./bot-notify-sender.js";

/**
 * Очередь дубля уведомлений в бота (docs/35-stage4-plan.md WP28). Лента пишет
 * строку и зовёт слушателя; слушатель ставит задание и не ждёт отправки —
 * подарок и заявка не зависят от того, ответил ли Telegram.
 *
 * - задание одно на уведомление: id задания — id уведомления, повторная
 *   постановка ничего не удвоит;
 * - площадка просит подождать — задание встаёт заново с её паузой, не больше
 *   `MAX_DEFERRALS` раз, потом исход «не доставлено»;
 * - сбой базы или Redis — штатный повтор BullMQ с растущей паузой;
 * - темп общий на все реплики: лимитер BullMQ живёт в Redis.
 */

const QUEUE_NAME = "notifications-bot";
const ENQUEUE_TIMEOUT_MS = 2_000;
const MAX_DEFERRALS = 3;
const JOB_OPTIONS = { attempts: 4, backoff: { type: "exponential", delay: 10_000, jitter: 0.5 }, removeOnComplete: 1000, removeOnFail: 1000 } as const;

/** Задание из Redis — граница: разбирается схемой, а не приводится. */
const jobSchema = z.object({
  notificationId: z.string().uuid(),
  accountId: z.string().uuid(),
  kind: z.string().min(1).max(32),
  payload: z.unknown(),
  /** сколько раз площадка уже просила подождать */
  deferrals: z.number().int().min(0).default(0),
});

type BotJob = z.input<typeof jobSchema>;

@Injectable()
export class BotNotifyQueue implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("notifications-bot");
  private queue: Queue<BotJob> | null = null;
  private worker: Worker<BotJob> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly notifications: NotificationsService,
    private readonly sender: BotNotifySender,
  ) {}

  onModuleInit(): void {
    this.notifications.onCreated("bot", (created) => this.enqueue(created));
  }

  /** Писать в бота можно только аккаунтам из базы — без входа игроков их нет. */
  get enabled(): boolean {
    return this.config.auth.enabled;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: consumer, concurrency: 1, limiter: { max: BOT_NOTIFY_PER_SEC, duration: 1000 } });
    this.worker.on("failed", (job, error) => {
      if (job === undefined || job.attemptsMade < JOB_OPTIONS.attempts) return;
      this.log("warn", "bot_notify_failed", { kind: job.data.kind, reason: error.message });
    });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  /** Слушатель ленты. Вид, который в бота не идёт, до Redis не доходит. */
  async enqueue(created: CreatedNotification): Promise<void> {
    if (this.queue === null || botRuleOf(created.kind) === undefined) return;
    const job: BotJob = { notificationId: created.notificationId, accountId: created.accountId, kind: created.kind, payload: created.payload };
    await withTimeout(this.queue.add("notify", job, { ...JOB_OPTIONS, jobId: created.notificationId }), ENQUEUE_TIMEOUT_MS, "очередь дубля в бота");
  }

  /** Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. */
  async process(job: Pick<Job<BotJob>, "data">): Promise<void> {
    const data = jobSchema.parse(job.data);
    const delivery = await this.sender.deliver(data);
    if (delivery.status === "failed") this.log("warn", "bot_notify_rejected", { kind: data.kind, reason: delivery.reason });
    if (delivery.status !== "retry") return;
    if (data.deferrals >= MAX_DEFERRALS || this.queue === null) {
      await this.notifications.markBot(data.notificationId, "failed");
      this.log("warn", "bot_notify_deferred_out", { kind: data.kind });
      return;
    }
    const next: BotJob = { ...data, deferrals: data.deferrals + 1 };
    await withTimeout(
      this.queue.add("notify", next, { ...JOB_OPTIONS, jobId: `${data.notificationId}-d${String(next.deferrals)}`, delay: Math.max(1, delivery.afterSec) * 1000 }),
      ENQUEUE_TIMEOUT_MS,
      "очередь дубля в бота",
    );
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "notifications-bot", event, ...fields }));
  }
}
