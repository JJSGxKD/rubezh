import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { parseJobId, REPLAY_QUEUE_NAME } from "./run-replay-rules.js";
import { RunReplayService } from "./run-replay.service.js";
import { RunProofsService } from "./run-proofs.service.js";
import { RunsHooks } from "./runs-hooks.js";

/**
 * Очередь повтора и расписание проходов (tasks/T-0319). Собранный бэкенд код
 * воркера не импортирует, поэтому имя очереди и форма задания повторены здесь, а
 * тест сверяет их с `apps/sim-worker/src/replay-job.ts`.
 *
 * Результат воркер возвращает тем же заданием, а сервер **читает** выполненные
 * задания проходом, а не слушает событие: проход может сделать любая реплика, а
 * исход закрывается идемпотентно (`RunReplayRepository.settle`) — фонового
 * потребителя, который пришлось бы закреплять за одной из реплик, нет.
 */

/** Задание очереди `replay` ровно в форме воркера (`replayJobSchema`, строгая: лишнего ключа он не примет). */
export interface ReplayJobPayload {
  runId: string;
  /** запись для проверки, распакованная */
  proof: unknown;
  /** снимок контента по хэшу записи; `null` — хэш совпадает со встроенным в воркер */
  contentSnapshot: unknown;
  /** итог, который клиент заявил серверу */
  claimed: { survivalSec: number; level: number; enemiesKilled: number };
}

/** Выполненное или упавшее задание — то, что читает проход. */
export interface FinishedReplayJob {
  jobId: string;
  runId: string;
  state: "completed" | "failed";
  /** возвращаемое значение воркера как есть: это данные из Redis, форму разбирает сервис */
  result: unknown;
  failedReason: string | null;
}

export interface ReplayQueue {
  /** поставить задание; тот же идентификатор второй раз — не новое задание (так устроен BullMQ) */
  add(payload: ReplayJobPayload, options: { jobId: string; priority: number }): Promise<void>;
  has(jobId: string): Promise<boolean>;
  /** выполненные и упавшие задания, старые первыми */
  finished(limit: number): Promise<FinishedReplayJob[]>;
  remove(jobId: string): Promise<void>;
}

/** Redis отвечает за миллисекунды; дольше трёх секунд проход ждать не должен. */
const REDIS_TIMEOUT_MS = 3_000;
/** Выполненное задание живёт сутки: проход идёт раз в минуту, а запас — на остановленный сервер. */
const KEEP_RESULT_SEC = 86_400;
const KEEP_FAILURE_SEC = 7 * 86_400;
/** Сбой Redis повторяется на каждом проходе — в лог не чаще раза в минуту. */
const LOG_INTERVAL_MS = 60_000;

export class BullReplayQueue implements ReplayQueue, OnModuleDestroy {
  private readonly logger = new Logger("run-replay");
  private queue: Queue<ReplayJobPayload> | null = null;
  private connection: Redis | null = null;
  private lastLoggedAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly queueName: string = REPLAY_QUEUE_NAME,
  ) {}

  /** Очередь открывается при первом обращении: процессам, которым повтор не нужен, соединение ни к чему. */
  private ensure(): Queue<ReplayJobPayload> {
    if (this.queue === null) {
      this.connection = createQueueConnection(this.config, "producer");
      this.queue = new Queue<ReplayJobPayload>(this.queueName, { connection: this.connection });
      // Без обработчика ошибка соединения — необработанное событие.
      this.queue.on("error", (error) => this.logThrottled(error.message));
    }
    return this.queue;
  }

  async add(payload: ReplayJobPayload, options: { jobId: string; priority: number }): Promise<void> {
    // Две попытки: сбой посреди повтора (перезапуск воркера) не должен стоить игроку проверки. Дальше — исход «broken», наша сторона.
    await withTimeout(
      this.ensure().add("replay", payload, {
        jobId: options.jobId,
        priority: options.priority,
        attempts: 2,
        backoff: { type: "fixed", delay: 30_000 },
        removeOnComplete: { age: KEEP_RESULT_SEC },
        removeOnFail: { age: KEEP_FAILURE_SEC },
      }),
      REDIS_TIMEOUT_MS,
      "очередь повтора",
    );
  }

  async has(jobId: string): Promise<boolean> {
    return (await withTimeout(this.ensure().getJob(jobId), REDIS_TIMEOUT_MS, "очередь повтора")) !== undefined;
  }

  async finished(limit: number): Promise<FinishedReplayJob[]> {
    const queue = this.ensure();
    const [completed, failed] = await Promise.all([
      withTimeout(queue.getJobs(["completed"], 0, limit - 1, true), REDIS_TIMEOUT_MS, "очередь повтора"),
      withTimeout(queue.getJobs(["failed"], 0, limit - 1, true), REDIS_TIMEOUT_MS, "очередь повтора"),
    ]);
    const out: FinishedReplayJob[] = [];
    for (const [state, jobs] of [["completed", completed], ["failed", failed]] as const) {
      for (const job of jobs) {
        if (job.id === undefined) continue;
        // Чужое задание в очереди этого имени — не наше: идентификатор по нашему правилу или поле забега.
        const runId = parseJobId(job.id)?.runId ?? (typeof job.data.runId === "string" ? job.data.runId : null);
        if (runId === null) continue;
        out.push({ jobId: job.id, runId, state, result: state === "completed" ? job.returnvalue : null, failedReason: state === "failed" ? (job.failedReason ?? "").slice(0, 300) || "задание упало" : null });
      }
    }
    return out.slice(0, limit);
  }

  async remove(jobId: string): Promise<void> {
    try {
      const job = await withTimeout(this.ensure().getJob(jobId), REDIS_TIMEOUT_MS, "очередь повтора");
      if (job !== undefined) await withTimeout(job.remove(), REDIS_TIMEOUT_MS, "очередь повтора");
    } catch (error: unknown) {
      // Идущее задание под замком воркера не снять, недоступный Redis — не повод ронять проход: срок хранения уберёт остальное.
      this.logThrottled(error instanceof Error ? error.message : "unknown");
    }
  }

  async onModuleDestroy(): Promise<void> {
    const queue = this.queue;
    const connection = this.connection;
    this.queue = null;
    this.connection = null;
    try {
      if (queue !== null) await withTimeout(queue.close(), REDIS_TIMEOUT_MS, "очередь повтора");
    } catch (error: unknown) {
      this.logThrottled(error instanceof Error ? error.message : "unknown");
    } finally {
      connection?.disconnect();
    }
  }

  private logThrottled(reason: string): void {
    const now = Date.now();
    if (now - this.lastLoggedAt < LOG_INTERVAL_MS) return;
    this.lastLoggedAt = now;
    this.logger.warn(JSON.stringify({ module: "runs", event: "replay_queue_error", reason }));
  }
}

const SWEEP_QUEUE = "run-replay-sweep";
const SWEEP_SCHEDULER_ID = "every-minute";
const SWEEP_EVERY_MS = 60_000;

/**
 * Подписки и проход раз в минуту. Подписки — слушатель записи забега (решить, нужен ли
 * повтор) и слушатель приёма записи (запись пришла — ставить задание). Проход —
 * повторяющееся задание BullMQ с одним идентификатором планировщика: перезапуск и
 * соседние реплики не заводят второе расписание, а проход выполняет одна из них;
 * повторный проход безопасен.
 */
@Injectable()
export class RunReplayJob implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("run-replay");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly replay: RunReplayService,
    private readonly hooks: RunsHooks,
    private readonly proofs: RunProofsService,
  ) {}

  onModuleInit(): void {
    this.hooks.onRecorded("replay", async (run) => await this.replay.onRecorded(run));
    this.proofs.onStored("replay", async (runId) => await this.replay.onProofStored(runId));
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(SWEEP_QUEUE, { connection: producer });
    this.worker = new Worker(SWEEP_QUEUE, async () => await this.replay.sweep(), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "runs", event: "replay_sweep_failed", reason: error.name })));
    // Без обработчика ошибка соединения воркера роняла бы процесс.
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "runs", event: "replay_worker_error", reason: error.name })));
    try {
      await this.queue.upsertJobScheduler(SWEEP_SCHEDULER_ID, { every: SWEEP_EVERY_MS }, { name: "sweep", opts: { removeOnComplete: 24, removeOnFail: 24 } });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "runs", event: "replay_schedule_failed", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }
}
