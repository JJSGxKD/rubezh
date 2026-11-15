import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { vkMessageEventSchema, type VkMessageEvent } from "./vk-events.js";
import { VkUpdatesWorker } from "./vk-updates.worker.js";

/**
 * Очередь событий сообщества VK (docs/35-stage4-plan.md Р188, tasks/T-0378):
 * сначала событие записывается в Redis, потом VK получает `ok`, а разбирает
 * его воркер — так перезапуск посреди разбора не теряет событие, а долгий
 * ответ игроку не задерживает VK: он ждёт `ok` считанные секунды и иначе
 * повторяет доставку. По образцу очереди бота Telegram.
 *
 * - id задания — `vk-<event_id>`: повтор доставки, пока VK не получил `ok`,
 *   второго задания не заводит. Выполненное задание помнит id час, упавшее —
 *   сутки;
 * - упавший разбор — штатный повтор BullMQ с растущей паузой: повтор безопасен,
 *   потому что связь записывается один раз по одноразовому коду, а ответ
 *   игроку после неё сбоем разбора не считается.
 */

const QUEUE_NAME = "vk-events";
const ENQUEUE_TIMEOUT_MS = 2_000;
const JOB_OPTIONS = { attempts: 5, backoff: { type: "exponential", delay: 5_000, jitter: 0.5 }, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86_400 } } as const;
const WORKER_CONCURRENCY = 4;

@Injectable()
export class VkEventQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("vk");
  private queue: Queue<VkMessageEvent> | null = null;
  private worker: Worker<VkMessageEvent> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly events: VkUpdatesWorker,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Без входа игроков нет аккаунтов, а значит и связывать нечего.
    if (!this.config.auth.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: consumer, concurrency: WORKER_CONCURRENCY });
    this.worker.on("failed", (job, error) => {
      if (job !== undefined) this.jobFailed(job, error);
    });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  /** Записать событие в очередь. Не записалось — бросает: вебхук ответит 503, и VK повторит доставку. */
  async enqueue(event: VkMessageEvent): Promise<void> {
    if (this.queue === null) throw new Error("Очередь событий VK не запущена");
    const options = event.eventId === null ? JOB_OPTIONS : { ...JOB_OPTIONS, jobId: `vk-${event.eventId}` };
    await withTimeout(this.queue.add("message", event, options), ENQUEUE_TIMEOUT_MS, "очередь событий VK");
  }

  /** Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. */
  async process(job: Pick<Job<unknown>, "data" | "attemptsMade">): Promise<void> {
    // Данные из Redis — граница: разбираются схемой, а не приводятся.
    const event = vkMessageEventSchema.safeParse(job.data);
    if (!event.success) {
      // Повтор не поможет: разбор не изменится.
      this.log("warn", "vk_event_dropped", { attempts: job.attemptsMade, reason: event.error.issues[0]?.message ?? "unknown" });
      return;
    }
    await this.events.handle(event.data);
  }

  /** Последняя попытка не удалась — событие брошено: в лог уровнем `error`, чтобы его заметили. */
  jobFailed(job: Pick<Job<unknown>, "attemptsMade" | "opts">, error: Error): void {
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    this.log("error", "vk_event_abandoned", { attempts: job.attemptsMade, reason: error.message });
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "vk", event, ...fields }));
  }
}
