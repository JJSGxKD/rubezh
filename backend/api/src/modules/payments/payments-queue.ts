import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { PaymentConfirmation, type ConfirmedPayment } from "./payment-confirmation.js";

/**
 * Очередь оплаты: подтверждения от Telegram записываются через неё, а не
 * прямо из обработчика обновления.
 *
 * Смещение опроса бота сохраняется до обработки, а вебхук отвечает Telegram
 * сразу (`bot-poller.ts`, `bot-webhook.controller.ts`): обновление, чья
 * обработка упала, второй раз не придёт. Для команды это потерянный ответ,
 * для оплаты — звёзды без продолжения. Поэтому подтверждение сначала
 * ложится в Redis, а запись в базу повторяется с паузой, пока не пройдёт, и
 * переживает перезапуск процесса.
 *
 * Redis недоступен — подтверждение пишется в базу сразу: оплата не должна
 * ждать очередь. Не записалось и так — ошибка в лог со всеми полями оплаты:
 * по ним человек сверит покупку руками.
 */

const QUEUE_NAME = "payments";
const ENQUEUE_TIMEOUT_MS = 2_000;
const JOB_OPTIONS = {
  attempts: 10,
  backoff: { type: "exponential", delay: 2_000, jitter: 0.5 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

type PaymentsJob = { kind: "confirm"; payment: ConfirmedPayment };

@Injectable()
export class PaymentsQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("payments");
  private queue: Queue<PaymentsJob> | null = null;
  private worker: Worker<PaymentsJob> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly confirmation: PaymentConfirmation,
  ) {}

  /** Оплату есть куда записать и есть кому о ней сообщить: база и бот, читающий обновления. */
  get enabled(): boolean {
    return this.config.auth.enabled && this.config.telegram.updates !== "off";
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: consumer, concurrency: 2 });
    this.worker.on("failed", (job, error) => {
      if (job === undefined) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1);
      this.log(final ? "error" : "warn", final ? "payment_job_abandoned" : "payment_job_failed", {
        ...describeJob(job.data),
        attempts: job.attemptsMade,
        reason: error.message,
      });
    });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  async confirm(payment: ConfirmedPayment): Promise<void> {
    const job: PaymentsJob = { kind: "confirm", payment };
    if (await this.enqueue(job, `confirm-${fingerprint(payment.chargeId)}`)) return;
    try {
      await this.process({ data: job });
    } catch (error: unknown) {
      this.log("error", "payment_unrecorded", { ...describeJob(job), reason: error instanceof Error ? error.message : "unknown" });
    }
  }

  /** Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. */
  async process(job: Pick<Job<PaymentsJob>, "data">): Promise<void> {
    await this.confirmation.confirm(job.data.payment);
  }

  private async enqueue(job: PaymentsJob, jobId: string): Promise<boolean> {
    if (this.queue === null) return false;
    try {
      // jobId от оплаты: повтор обновления не заведёт второе задание.
      await withTimeout(this.queue.add(job.kind, job, { jobId, ...JOB_OPTIONS }), ENQUEUE_TIMEOUT_MS, "очередь оплаты");
      return true;
    } catch (error: unknown) {
      this.log("warn", "enqueue_failed", { ...describeJob(job), reason: error instanceof Error ? error.message : "unknown" });
      return false;
    }
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

/**
 * Идентификатор оплаты Telegram — непрозрачная строка, а BullMQ не пускает
 * двоеточие в свои идентификаторы: в jobId идёт её отпечаток.
 */
function fingerprint(chargeId: string): string {
  return createHash("sha256").update(chargeId).digest("hex").slice(0, 32);
}

function describeJob(job: PaymentsJob): Record<string, unknown> {
  const { payment } = job;
  return { kind: job.kind, chargeId: payment.chargeId, purchaseId: payment.payload, userId: payment.userId, stars: payment.totalAmount };
}
