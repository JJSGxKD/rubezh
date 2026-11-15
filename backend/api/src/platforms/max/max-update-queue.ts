import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { BOT_STARTED, botStartedSchema, type MaxBotStarted } from "./max-update.js";
import { MaxUpdatesWorker } from "./max-updates.worker.js";

/**
 * Очередь событий бота MAX (docs/35-stage4-plan.md Р188, tasks/T-0379), по
 * образцу очереди Telegram (`telegram/bot-update-queue.ts`): событие
 * записывается в Redis до того, как MAX получит «принято», а разбирает его
 * воркер. Иначе перезапуск посреди обработки терял бы событие, а MAX
 * доставленное не повторяет.
 *
 * - **Повтор отсекается по id задания.** У события MAX нет своего
 *   идентификатора, поэтому id — игрок, время события (мс) и короткий хеш
 *   кода: один и тот же старт, доставленный дважды (вебхук после ответа 503),
 *   второго задания не заводит. Код в Redis открытым не лежит. Двоеточие в id
 *   BullMQ не допускает — разделитель дефис.
 * - **Упавший обработчик** — штатный повтор BullMQ с растущей паузой.
 * - **Выполненное задание помнится сутки.** MAX повторяет доставку до 8 часов и
 *   потом отписывает бота; повтор за пределами памяти задания применил бы уже
 *   забранный код и ответил бы связанному игроку «ссылка устарела».
 */

const QUEUE_NAME = "max-updates";
const ENQUEUE_TIMEOUT_MS = 2_000;
const JOB_OPTIONS = { attempts: 5, backoff: { type: "exponential", delay: 5_000, jitter: 0.5 }, removeOnComplete: { age: 86_400 }, removeOnFail: { age: 86_400 } } as const;
const WORKER_CONCURRENCY = 4;
const PAYLOAD_HASH_CHARS = 16;

/** Id задания: один и тот же старт — один id. */
export function jobIdOf(event: MaxBotStarted): string {
  const code = createHash("sha256")
    .update(event.payload ?? "")
    .digest("hex")
    .slice(0, PAYLOAD_HASH_CHARS);
  return `${BOT_STARTED}-${String(event.user.user_id)}-${String(event.timestamp)}-${code}`;
}

@Injectable()
export class MaxUpdateQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("max");
  private queue: Queue<MaxBotStarted> | null = null;
  private worker: Worker<MaxBotStarted> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly updates: MaxUpdatesWorker,
  ) {}

  /**
   * Очередь и воркер запускаются всегда, а не только при заданном ключе: ключ и
   * секрет вводятся в панели без перезапуска, и вебхук начинает принимать события
   * в ту же минуту.
   */
  async onApplicationBootstrap(): Promise<void> {
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: consumer, concurrency: WORKER_CONCURRENCY });
    this.worker.on("failed", (job, error) => {
      if (job !== undefined) this.jobFailed(job, error);
    });
    this.worker.on("error", (error) => this.log("warn", "max_worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  /**
   * Записать событие в очередь. Не записалось — бросает: вебхук ответит 503, и
   * MAX повторит доставку (повтор отсечёт id задания, если запись всё же дошла).
   */
  async enqueue(event: MaxBotStarted): Promise<void> {
    if (this.queue === null) throw new Error("Очередь событий MAX не запущена");
    await withTimeout(this.queue.add(BOT_STARTED, event, { ...JOB_OPTIONS, jobId: jobIdOf(event) }), ENQUEUE_TIMEOUT_MS, "очередь событий MAX");
  }

  /** Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. */
  async process(job: Pick<Job<unknown>, "data" | "attemptsMade">): Promise<void> {
    // Данные из Redis — граница: разбираются схемой, а не приводятся.
    const event = botStartedSchema.safeParse(job.data);
    if (!event.success) {
      // Повтор не поможет: разбор не изменится.
      this.log("warn", "max_update_dropped", { attempts: job.attemptsMade, reason: event.error.issues[0]?.message ?? "unknown" });
      return;
    }
    await this.updates.handle(event.data);
  }

  /** Последняя попытка не удалась — событие брошено: в лог уровнем `error`, чтобы его заметили. Вынесено ради тестов. */
  jobFailed(job: Pick<Job<unknown>, "attemptsMade" | "opts">, error: Error): void {
    const final = job.attemptsMade >= (job.opts.attempts ?? 1) || error.name === "UnrecoverableError";
    if (!final) return;
    this.log("error", "max_update_abandoned", { attempts: job.attemptsMade, reason: error.message });
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "max", event, ...fields }));
  }
}
