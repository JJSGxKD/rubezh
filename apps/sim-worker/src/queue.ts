import { Worker, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { runCheck, type BaseRunCache, type CheckDeps, type CheckResult } from "./check";
import { checkJobSchema, jsonBytes, type CheckJobInput } from "./job";
import { CONTENT_CHECK_QUEUE, QUEUE_BUSY_MESSAGE, QUEUE_MAX_WAITING, SNAPSHOT_MAX_BYTES, SNAPSHOT_TOO_LARGE } from "./limits";
import { logEvent } from "./log";
import type { Metrics, Outcome } from "./metrics";

/**
 * Очередь `content-check` (docs/35-stage4-plan.md Р15, tasks/T-0302): сервер
 * ставит задание, воркер проверяет, результат возвращается тем же заданием —
 * сервер читает его событием завершения. Конкурентность — 1: прогон занимает
 * процессор целиком.
 */

/** Очередь занята: ждущих уже пять. */
export class CheckQueueBusyError extends Error {
  constructor() {
    super(QUEUE_BUSY_MESSAGE);
    this.name = "CheckQueueBusyError";
  }
}

export class SnapshotTooLargeError extends Error {
  constructor() {
    super(SNAPSHOT_TOO_LARGE);
    this.name = "SnapshotTooLargeError";
  }
}

/** Что нужно от очереди производителю; настоящая `Queue` BullMQ подходит, подмена в тестах — тоже. */
export interface CheckQueueLike {
  getWaitingCount(): Promise<number>;
  add(name: string, data: CheckJobInput, opts?: JobsOptions): Promise<{ id?: string | undefined }>;
}

/** Результат хранится час, неудача — сутки: этого хватает, чтобы прочитать итог, и не копит снимки в Redis. */
const KEEP_RESULT_SEC = 3_600;
const KEEP_FAILURE_SEC = 86_400;

/**
 * Поставить проверку в очередь; возвращает идентификатор задания. Отказ — до
 * очереди: форма задания, размер снимков (2 МБ каждый) и «ждущих не больше
 * пяти». Счёт ждущих и постановка — два запроса, поэтому при одновременных
 * заявках очередь может выйти за предел на единицу-другую: предел бережёт
 * Redis и терпение человека, а не деньги.
 */
export async function submitCheck(queue: CheckQueueLike, job: CheckJobInput): Promise<string> {
  const parsed = checkJobSchema.parse(job);
  if (jsonBytes(parsed.snapshot) > SNAPSHOT_MAX_BYTES || jsonBytes(parsed.baseSnapshot) > SNAPSHOT_MAX_BYTES) throw new SnapshotTooLargeError();
  if ((await queue.getWaitingCount()) >= QUEUE_MAX_WAITING) throw new CheckQueueBusyError();
  const added = await queue.add("check", parsed, {
    jobId: parsed.checkId,
    attempts: 1,
    removeOnComplete: { age: KEEP_RESULT_SEC },
    removeOnFail: { age: KEEP_FAILURE_SEC },
  });
  return added.id ?? parsed.checkId;
}

const outcomeOf = (result: CheckResult): Outcome => (result.schemaProblems.length > 0 ? "invalid" : result.report?.timeout === true ? "timeout" : "ok");

export interface CheckWorkerOptions {
  /** соединение для воркера: `maxRetriesPerRequest: null` — требование BullMQ */
  connection: Redis;
  /** имя очереди; в тестах — своё, чтобы не задеть чужое */
  queueName?: string;
  metrics: Metrics;
  deps?: CheckDeps;
}

/**
 * Воркер очереди. Блокировка задания — минута: прогон отдаёт управление циклу
 * событий между забегами, и продление блокировки успевает; без этого очередь
 * сочла бы долгий прогон зависшим и отдала бы его второй раз.
 */
export function createCheckWorker(options: CheckWorkerOptions): Worker<CheckJobInput, CheckResult> {
  const baseRuns: BaseRunCache = new Map();
  const worker = new Worker<CheckJobInput, CheckResult>(
    options.queueName ?? CONTENT_CHECK_QUEUE,
    async (job) => {
      const started = performance.now();
      const seconds = (): number => (performance.now() - started) / 1000;
      try {
        const result = await runCheck(job.data, { baseRuns, ...options.deps });
        options.metrics.observe(CONTENT_CHECK_QUEUE, outcomeOf(result), seconds());
        return result;
      } catch (error: unknown) {
        options.metrics.observe(CONTENT_CHECK_QUEUE, "error", seconds());
        throw error;
      }
    },
    { connection: options.connection, concurrency: 1, lockDuration: 60_000 },
  );
  worker.on("failed", (job, error) => logEvent("warn", "check_failed", { jobId: job?.id ?? null, reason: error.name }));
  // Без обработчика ошибка соединения воркера роняла бы процесс.
  worker.on("error", (error) => logEvent("warn", "worker_error", { reason: error.message }));
  return worker;
}
