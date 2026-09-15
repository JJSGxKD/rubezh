import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { DiagnosticsHooks, type ReceivedReport } from "../diagnostics/diagnostics-hooks.js";
import { benchSummaryOf } from "../diagnostics/diagnostics-summary.js";
import { DIAGNOSTICS_REPOSITORY, type DiagnosticsRepository } from "../diagnostics/diagnostics.repository.js";
import { TelegramApiError, type TelegramBotApi } from "../telegram/telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "../telegram/telegram.module.js";
import { renderStressCardPng, stressCaption, type StressCardInput } from "./stress-card.js";

/**
 * Уведомления в чат администраторов о новых отчётах диагностики: каждый
 * стресс-тест — карточкой с графиком. Записи забегов (WP7) — только
 * проблемные, остальные уходят в ежедневную сводку.
 *
 * Отправка — через очередь, а не из обработчика отчёта:
 * - Telegram пускает в группу около 20 сообщений в минуту, и волна стресс-тестов
 *   после поста в канале упёрлась бы в `429` — очередь держит темп сама;
 * - упавшая отправка повторяется с паузой, `retry_after` Telegram уважается;
 * - перезапуск бэкенда не теряет уведомления, которые ещё не ушли.
 *
 * В задании — только `reportId`: картинка рисуется по отчёту из базы, и
 * очередь не хранит таймлайн второй копией.
 */

const QUEUE_NAME = "admin-notify";
/** Ниже лимита Telegram на группу с запасом: сводка по `/stats` идёт в тот же чат мимо очереди. */
const MESSAGES_PER_MINUTE = 15;
const ENQUEUE_TIMEOUT_MS = 2_000;

interface NotifyJob {
  reportId: string;
}

export type NotifierBotApi = Pick<TelegramBotApi, "sendPhoto">;

@Injectable()
export class ReportNotifier implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("admin-notify");
  private queue: Queue<NotifyJob> | null = null;
  private worker: Worker<NotifyJob> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hooks: DiagnosticsHooks,
    @Inject(DIAGNOSTICS_REPOSITORY) private readonly reports: DiagnosticsRepository,
    @Inject(TELEGRAM_BOT_API) private readonly api: NotifierBotApi,
  ) {}

  get enabled(): boolean {
    const { telegram, notifyReports, ingest } = this.config;
    return notifyReports && ingest.reportsEnabled && telegram.adminChatId !== "" && telegram.botToken !== "";
  }

  onModuleInit(): void {
    if (this.enabled) this.hooks.onReport("admin-notify", (report) => this.enqueue(report));
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
      connection: consumer,
      concurrency: 1,
      limiter: { max: MESSAGES_PER_MINUTE, duration: 60_000 },
    });
    this.worker.on("failed", (job, error) => {
      this.log("warn", "notify_failed", { reportId: job?.data.reportId ?? null, attempts: job?.attemptsMade ?? 0, reason: error.message });
    });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  async enqueue(report: ReceivedReport): Promise<void> {
    if (report.kind !== "bench" || this.queue === null) return;
    // jobId от reportId: повтор отчёта не породит второе уведомление. Двоеточие
    // BullMQ в своих идентификаторах не пускает — это разделитель его ключей.
    await withTimeout(
      this.queue.add(
        "report",
        { reportId: report.reportId },
        {
          jobId: `report-${report.reportId}`,
          attempts: 6,
          backoff: { type: "exponential", delay: 5_000, jitter: 0.5 },
          removeOnComplete: 500,
          removeOnFail: 500,
        },
      ),
      ENQUEUE_TIMEOUT_MS,
      "очередь уведомлений",
    );
  }

  /** Одна отправка. Вынесена ради тестов: очередь вокруг неё — BullMQ. */
  async process(job: Pick<Job<NotifyJob>, "data">): Promise<void> {
    const stored = await this.reports.findBench(job.data.reportId);
    // Отчёт удалён сроком хранения или не разбирается нынешней схемой —
    // повтор не поможет.
    if (stored === null) throw new UnrecoverableError(`отчёт ${job.data.reportId} не найден`);

    const input: StressCardInput = { ...stored, summary: benchSummaryOf(stored.payload) };
    try {
      await this.api.sendPhoto(this.config.telegram.adminChatId, renderStressCardPng(input), stressCaption(input));
      this.log("log", "notify_sent", { reportId: stored.reportId });
    } catch (error: unknown) {
      if (error instanceof TelegramApiError && error.errorCode === 429 && error.retryAfterSec !== null && this.queue !== null) {
        // Telegram сам сказал, сколько ждать: притормаживаем всю очередь,
        // а не только это задание.
        await this.queue.rateLimit(error.retryAfterSec * 1000);
        throw Worker.RateLimitError();
      }
      // Чат не найден, бота выгнали — повтором не лечится.
      if (error instanceof TelegramApiError && error.errorCode >= 400 && error.errorCode < 500 && error.errorCode !== 429) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "admin-notify", event, ...fields }));
  }
}
