import { Logger, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { PayloadTooLargeError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import type { AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { ContentCheckBusyError } from "./content-errors.js";

/**
 * Очередь проверок черновика контента: сервер ставит задание, `sim-worker`
 * проверяет и возвращает отчёт тем же заданием (docs/19-content-admin.md §4.3,
 * docs/35-stage4-plan.md Р15, tasks/T-0302).
 *
 * Собранный бэкенд код воркера не импортирует, поэтому имя очереди, форма
 * задания и пределы повторены здесь; тест сверяет их с `apps/sim-worker/src/limits.ts`.
 * Пределы воркер проверяет и сам — копия здесь нужна, чтобы отказать человеку
 * сразу, а не положить в Redis то, что воркер всё равно отклонит.
 */

export const CONTENT_CHECK_QUEUE = Symbol("CONTENT_CHECK_QUEUE");

export const CONTENT_CHECK_QUEUE_NAME = "content-check";
/** Ждущих заданий не больше; выполняемое сюда не входит. */
export const CONTENT_CHECK_QUEUE_MAX_WAITING = 5;
/** Снимок больше этого воркер не разбирает. */
export const CONTENT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOO_LARGE = "Снимок больше 2 МБ";

/** Результат хранится час, неудача — сутки: этого хватает, чтобы прочитать итог, и не копит снимки в Redis. */
const KEEP_RESULT_SEC = 3_600;
const KEEP_FAILURE_SEC = 86_400;
/** Redis отвечает за миллисекунды; дольше трёх секунд человек ждать не должен. */
const REDIS_TIMEOUT_MS = 3_000;
/** Сбой Redis повторяется на каждом запросе — в лог не чаще раза в минуту. */
const LOG_INTERVAL_MS = 60_000;

/** Задание очереди в форме воркера (`checkJobSchema`); сценарии и зёрна воркер дозаполнит сам. */
export interface CheckJobPayload {
  checkId: string;
  snapshot: unknown;
  baseSnapshot: unknown;
}

/**
 * Где задание сейчас. `pending` — ждёт или считается; `finished` несёт итог
 * воркера как есть (разбирает его вызывающий: это данные из Redis);
 * `missing` — в очереди нет: ещё не дошло, уже стёрто по сроку или снято.
 */
export type CheckJobState = { state: "pending" } | { state: "finished"; result: unknown } | { state: "failed"; reason: string } | { state: "missing" };

export interface ContentCheckQueue {
  /** `ContentCheckBusyError` — ждущих уже пять; `PayloadTooLargeError` — снимок больше 2 МБ */
  submit(job: CheckJobPayload): Promise<void>;
  poll(checkId: string): Promise<CheckJobState>;
  /** снять ждущее задание; идущее считается до конца, ошибки снятия не важны */
  cancel(checkId: string): Promise<void>;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

export class BullContentCheckQueue implements ContentCheckQueue, OnModuleDestroy {
  private readonly logger = new Logger("content-check");
  private queue: Queue<CheckJobPayload> | null = null;
  private connection: Redis | null = null;
  private lastLoggedAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly queueName: string = CONTENT_CHECK_QUEUE_NAME,
  ) {}

  /** Очередь открывается при первой проверке: процессам, которые проверок не ставят, соединение не нужно. */
  private ensure(): Queue<CheckJobPayload> {
    if (this.queue === null) {
      this.connection = createQueueConnection(this.config, "producer");
      this.queue = new Queue<CheckJobPayload>(this.queueName, { connection: this.connection });
      // Без обработчика ошибка соединения — необработанное событие.
      this.queue.on("error", (error) => this.logThrottled(error.message));
    }
    return this.queue;
  }

  async submit(job: CheckJobPayload): Promise<void> {
    if (jsonBytes(job.snapshot) > CONTENT_SNAPSHOT_MAX_BYTES || jsonBytes(job.baseSnapshot) > CONTENT_SNAPSHOT_MAX_BYTES) throw new PayloadTooLargeError(SNAPSHOT_TOO_LARGE);
    const queue = this.ensure();
    // Счёт ждущих и постановка — два запроса: при одновременных заявках очередь может выйти за предел на единицу-другую.
    // Предел бережёт Redis и терпение человека, а не деньги.
    if ((await withTimeout(queue.getWaitingCount(), REDIS_TIMEOUT_MS, "очередь проверок")) >= CONTENT_CHECK_QUEUE_MAX_WAITING) throw new ContentCheckBusyError();
    await withTimeout(
      queue.add("check", job, { jobId: job.checkId, attempts: 1, removeOnComplete: { age: KEEP_RESULT_SEC }, removeOnFail: { age: KEEP_FAILURE_SEC } }),
      REDIS_TIMEOUT_MS,
      "очередь проверок",
    );
  }

  async poll(checkId: string): Promise<CheckJobState> {
    const queue = this.ensure();
    const job = await withTimeout(queue.getJob(checkId), REDIS_TIMEOUT_MS, "очередь проверок");
    if (job === undefined) return { state: "missing" };
    const state = await withTimeout(job.getState(), REDIS_TIMEOUT_MS, "очередь проверок");
    if (state === "completed") return { state: "finished", result: job.returnvalue };
    if (state === "failed") return { state: "failed", reason: (job.failedReason ?? "").slice(0, 300) || "проверка завершилась ошибкой" };
    if (state === "unknown") return { state: "missing" };
    return { state: "pending" };
  }

  async cancel(checkId: string): Promise<void> {
    try {
      const job = await withTimeout(this.ensure().getJob(checkId), REDIS_TIMEOUT_MS, "очередь проверок");
      await job?.remove();
    } catch (error: unknown) {
      // Идущее задание снять нельзя (оно под замком), недоступный Redis — не повод ронять запрос: проверка и так помечена.
      this.logThrottled(error instanceof Error ? error.message : "unknown");
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.connection?.disconnect();
    this.queue = null;
    this.connection = null;
  }

  private logThrottled(reason: string): void {
    const now = Date.now();
    if (now - this.lastLoggedAt < LOG_INTERVAL_MS) return;
    this.lastLoggedAt = now;
    this.logger.warn(JSON.stringify({ module: "content-check", event: "queue_error", reason }));
  }
}
