import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { BotRouter } from "./bot-router.js";
import { updateSchema, type TelegramUpdate } from "./telegram-bot-api.js";

/**
 * Очередь обновлений бота (docs/28-diagnostics.md §6.1.3): обновление
 * записывается в Redis до того, как Telegram получит «принято», а разбирает
 * его воркер. Раньше вебхук отвечал сразу и обрабатывал после ответа, а опрос
 * сдвигал смещение до обработки: перезапуск посреди обработки стирал
 * обновление, в том числе сообщение об успешной оплате, — Telegram повторять
 * доставленное не станет.
 *
 * - id задания — `update-<update_id>`: повтор одного обновления (вебхук после
 *   ответа 503, опрос с несдвинутым смещением) второго задания не заводит;
 * - упавший обработчик — штатный повтор BullMQ с растущей паузой. Повтор
 *   безопасен: запись оплаты идемпотентна по id оплаты, второй ответ на
 *   предварительную проверку Telegram не примет, приветствие отсекает
 *   двойное нажатие своим окном;
 * - приоритет получают все задания: оплата — выше, обычные — ниже.
 *   Предварительную проверку надо ответить за десять секунд, а задание без
 *   приоритета BullMQ берёт раньше любого приоритетного: оставь обычные без
 *   него, и оплата встала бы за всеми `/start`.
 */

const QUEUE_NAME = "bot-updates";
const ENQUEUE_TIMEOUT_MS = 2_000;
/** Повтор одного update_id Telegram шлёт в первые минуты, сутки — предел: выполненное задание помнит id час, упавшее — сутки. */
const JOB_OPTIONS = { attempts: 5, backoff: { type: "exponential", delay: 5_000, jitter: 0.5 }, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86_400 } } as const;
/** Оплата ждёт ответа 10 секунд — её задания вперёд остальных. */
const URGENT_PRIORITY = 1;
/** Приоритет и у обычных: задание без приоритета BullMQ берёт раньше любого приоритетного. */
const ORDINARY_PRIORITY = 2;
const WORKER_CONCURRENCY = 8;

/**
 * Обновление, на которое Telegram ждёт ответа за считанные секунды: оплата.
 * Предварительную проверку надо ответить за десять секунд, а карточка
 * приветствия в соседнем обновлении рисуется секунды.
 */
export function isUrgent(update: TelegramUpdate): boolean {
  return update.pre_checkout_query !== undefined || update.message?.successful_payment !== undefined;
}

const updateIdSchema = z.object({ update_id: z.number().int() });

/** Номер обновления из данных задания — для лога; повреждённое задание его не называет. */
function updateIdOf(data: unknown): number | null {
  const parsed = updateIdSchema.safeParse(data);
  return parsed.success ? parsed.data.update_id : null;
}

@Injectable()
export class BotUpdateQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("bot");
  private queue: Queue<TelegramUpdate> | null = null;
  private worker: Worker<TelegramUpdate> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Чтение обновлений выключено — принимать и разбирать нечего.
    if (this.config.telegram.updates === "off") return;
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

  /**
   * Записать обновление в очередь. Не записалось — бросает: вебхук ответит
   * 503 (Telegram повторит доставку сам), опрос не сдвинет смещение.
   */
  async enqueue(update: TelegramUpdate): Promise<void> {
    if (this.queue === null) throw new Error("Очередь обновлений бота не запущена");
    const priority = isUrgent(update) ? URGENT_PRIORITY : ORDINARY_PRIORITY;
    const options = { ...JOB_OPTIONS, jobId: `update-${String(update.update_id)}`, priority };
    await withTimeout(this.queue.add("update", update, options), ENQUEUE_TIMEOUT_MS, "очередь обновлений бота");
  }

  /** Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. */
  async process(job: Pick<Job<unknown>, "data" | "attemptsMade">): Promise<void> {
    // Данные из Redis — граница: разбираются схемой, а не приводятся.
    const update = updateSchema.safeParse(job.data);
    if (!update.success) {
      // Повтор не поможет: разбор не изменится.
      this.log("warn", "bot_update_dropped", { updateId: updateIdOf(job.data), attempts: job.attemptsMade, reason: update.error.issues[0]?.message ?? "unknown" });
      return;
    }
    const result = await this.router.dispatch(update.data);
    if (result.status === "failed") throw new Error(`обработчик ${result.handler} упал`);
  }

  /**
   * Попытка не удалась. Последняя — обновление брошено: в лог уровнем `error`,
   * чтобы его заметили, пока Telegram не прислал повтор. Вынесено ради тестов.
   */
  jobFailed(job: Pick<Job<unknown>, "data" | "attemptsMade" | "opts">, error: Error): void {
    const final = job.attemptsMade >= (job.opts.attempts ?? 1) || error.name === "UnrecoverableError";
    if (!final) return;
    this.log("error", "bot_update_abandoned", { updateId: updateIdOf(job.data), attempts: job.attemptsMade, reason: error.message });
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "bot", event, ...fields }));
  }
}
