import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
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
 * - тихие часы (Р199) — задание встаёт заново на конец тихих часов, один раз и
 *   без траты `MAX_DEFERRALS`: это не отказ площадки;
 * - сбой базы или Redis — штатный повтор BullMQ с растущей паузой;
 * - темп общий на все реплики: лимитер BullMQ живёт в Redis;
 * - тем же лимитером идут правки и отправки живых карточек бота (Р199, tasks/T-0395):
 *   задания с другими именами (`card-edit`, `card-send`, …) регистрирует модуль карточек
 *   через `registerPaced`, а ставит через `addPaced`. Темп 5 в секунду один на дубль и
 *   карточки, а задания `notify` разбираются ровно как раньше.
 */

const QUEUE_NAME = "notifications-bot";
/** Имя задания дубля уведомления; задание без имени (поставленное до карточек) разбирается так же. */
const NOTIFY_JOB = "notify";
const ENQUEUE_TIMEOUT_MS = 2_000;
const MAX_DEFERRALS = 3;
const JOB_OPTIONS = { attempts: 4, backoff: { type: "exponential", delay: 10_000, jitter: 0.5 }, removeOnComplete: 1000, removeOnFail: 1000 } as const;
/**
 * Задания карточек. Выполненное и упавшее удаляются: BullMQ отклоняет повтор `jobId`, пока задание
 * хранится, а карточке нужен тот же идентификатор («правка этой карточки») снова и снова.
 */
const PACED_OPTIONS = { attempts: 3, backoff: { type: "exponential", delay: 10_000 }, removeOnComplete: true, removeOnFail: true } as const;

/** Задание из Redis — граница: разбирается схемой, а не приводится. */
const jobSchema = z.object({
  notificationId: z.string().uuid(),
  accountId: z.string().uuid(),
  kind: z.string().min(1).max(32),
  payload: z.unknown(),
  /** сколько раз площадка уже просила подождать */
  deferrals: z.number().int().min(0).default(0),
  /** задание уже ждало конца тихих часов (Р199): второй раз не откладывается */
  quietDeferred: z.boolean().default(false),
});

type BotJob = z.input<typeof jobSchema>;

/** Обработчик задания карточек: данные из Redis — граница, его схема — дело обработчика. */
export type PacedHandler = (data: unknown) => Promise<void>;

export interface PacedOptions {
  /** один идентификатор — одно задание, пока оно не выполнено; двоеточие BullMQ в нём не пропускает */
  jobId: string;
  delayMs: number;
}

@Injectable()
export class BotNotifyQueue implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("notifications-bot");
  private queue: Queue<unknown> | null = null;
  private worker: Worker<unknown> | null = null;
  private connections: Redis[] = [];
  private readonly paced = new Map<string, PacedHandler>();

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
    this.queue = new Queue<unknown>(QUEUE_NAME, { connection: producer });
    this.worker = new Worker<unknown>(QUEUE_NAME, (job) => this.process(job), { connection: consumer, concurrency: 1, limiter: { max: BOT_NOTIFY_PER_SEC, duration: 1000 } });
    this.worker.on("failed", (job, error) => {
      if (job === undefined || job.attemptsMade < (job.opts.attempts ?? 1)) return;
      if (job.name === NOTIFY_JOB || job.name === "") this.log("warn", "bot_notify_failed", { kind: kindOf(job.data), reason: error.message });
      else this.log("warn", "bot_paced_failed", { name: job.name, reason: error.message });
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
    await withTimeout(this.queue.add(NOTIFY_JOB, job, { ...JOB_OPTIONS, jobId: created.notificationId }), ENQUEUE_TIMEOUT_MS, "очередь дубля в бота");
  }

  /**
   * Обработчик заданий карточек под своим именем. Имя `notify` занято дублем, повтор имени —
   * ошибка: два обработчика одного имени делили бы задания молча и непредсказуемо.
   */
  registerPaced(name: string, handler: PacedHandler): void {
    if (name === NOTIFY_JOB || name === "") throw new Error(`Имя задания «${name}» занято дублем уведомлений`);
    if (this.paced.has(name)) throw new Error(`Обработчик задания «${name}» уже зарегистрирован`);
    this.paced.set(name, handler);
  }

  /**
   * Поставить задание карточек под общим лимитером. `false` — очередь не запущена (вход игроков
   * выключен): отложить нечем, и вызывающий решает сам. Тот же `jobId`, пока задание ждёт или
   * выполняется, второго задания не ставит — так правки одной карточки сливаются.
   */
  async addPaced(name: string, data: unknown, options: PacedOptions): Promise<boolean> {
    if (this.queue === null) return false;
    await withTimeout(this.queue.add(name, data, { ...PACED_OPTIONS, jobId: options.jobId, delay: Math.max(0, Math.floor(options.delayMs)) }), ENQUEUE_TIMEOUT_MS, "очередь карточек бота");
    return true;
  }

  /**
   * Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. Имя `notify` и задание без имени —
   * дубль уведомления; остальные имена — обработчик карточек, незнакомое — выход без ошибки:
   * иначе задание от более новой версии крутилось бы в повторах на старой реплике.
   */
  async process(job: { name?: string; data: unknown }): Promise<void> {
    if (job.name !== undefined && job.name !== "" && job.name !== NOTIFY_JOB) {
      const handler = this.paced.get(job.name);
      if (handler === undefined) this.log("warn", "paced_unknown", { name: job.name });
      else await handler(job.data);
      return;
    }
    await this.processNotify(job.data);
  }

  private async processNotify(raw: unknown): Promise<void> {
    const data = jobSchema.parse(raw);
    const delivery = await this.sender.deliver(data);
    if (delivery.status === "failed") this.log("warn", "bot_notify_rejected", { kind: data.kind, reason: delivery.reason });
    if (delivery.status === "deferred") {
      await this.deferToMorning(data, delivery.afterSec);
      return;
    }
    if (delivery.status !== "retry") return;
    if (data.deferrals >= MAX_DEFERRALS || this.queue === null) {
      await this.notifications.markBot(data.notificationId, "failed");
      this.log("warn", "bot_notify_deferred_out", { kind: data.kind });
      return;
    }
    const next: BotJob = { ...data, deferrals: data.deferrals + 1 };
    await withTimeout(
      this.queue.add(NOTIFY_JOB, next, { ...JOB_OPTIONS, jobId: `${data.notificationId}-d${String(next.deferrals)}`, delay: Math.max(1, delivery.afterSec) * 1000 }),
      ENQUEUE_TIMEOUT_MS,
      "очередь дубля в бота",
    );
  }

  /** Тихие часы: то же задание после их конца, с отметкой, что откладывалось. Счётчик отказов площадки не меняется. */
  private async deferToMorning(data: z.output<typeof jobSchema>, afterSec: number): Promise<void> {
    if (this.queue === null) {
      await this.notifications.markBot(data.notificationId, "failed");
      this.log("warn", "bot_notify_deferred_out", { kind: data.kind });
      return;
    }
    const next: BotJob = { ...data, quietDeferred: true };
    await withTimeout(this.queue.add(NOTIFY_JOB, next, { ...JOB_OPTIONS, jobId: `${data.notificationId}-q`, delay: Math.max(1, afterSec) * 1000 }), ENQUEUE_TIMEOUT_MS, "очередь дубля в бота");
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "notifications-bot", event, ...fields }));
  }
}

/** Вид уведомления из данных задания для строки лога; данные из Redis — граница, поэтому без приведения. */
function kindOf(data: unknown): string {
  const kind = typeof data === "object" && data !== null ? (data as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" ? kind : "unknown";
}
