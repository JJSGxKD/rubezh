import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { DiagnosticsHooks, type ReceivedReport } from "../diagnostics/diagnostics-hooks.js";
import { benchSummaryOf, runSummaryOf } from "../diagnostics/diagnostics-summary.js";
import { DIAGNOSTICS_REPOSITORY, type DiagnosticsRepository } from "../diagnostics/diagnostics.repository.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import type { ChatTarget } from "../../platforms/telegram/chat-target.js";
import { TelegramApiError, type TelegramBotApi } from "../../platforms/telegram/telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "../../platforms/telegram/telegram-bot-api.js";
import { renderRunCardPng, runCaption, type RunCardInput } from "./run-card.js";
import { renderStressCardPng, stressCaption, type StressCardInput } from "./stress-card.js";
import { REVIEW_THROTTLE, type ReviewThrottle } from "./review-throttle.js";
import { reviewCardText, type ReviewCardRun } from "./run-review-card.js";

/**
 * Уведомления в чат администраторов о новых отчётах диагностики: каждый
 * стресс-тест — карточкой с графиком, запись забега — только проблемная
 * (рывки кадров, догоняние симуляции, ошибки клиента). Остальные записи —
 * счётчиком в ежедневной сводке: карточка на каждый забег утопила бы чат.
 *
 * Отправка — через очередь, а не из обработчика отчёта:
 * - Telegram пускает в группу около 20 сообщений в минуту, и волна стресс-тестов
 *   после поста в канале упёрлась бы в `429` — очередь держит темп сама;
 * - упавшая отправка повторяется с паузой, `retry_after` Telegram уважается;
 * - перезапуск бэкенда не теряет уведомления, которые ещё не ушли.
 *
 * В задании — только `reportId`: картинка рисуется по отчёту из базы, и
 * очередь не хранит таймлайн второй копией.
 *
 * Та же очередь везёт **карточки забегов на разбор** — подозрительных и
 * отклонённых антифродом (docs/34-stage3-plan.md, WP4). Очередь одна
 * намеренно: у чата администраторов один лимит сообщений, и две очереди с
 * собственными ограничителями вместе превысили бы его, не зная друг о друге.
 * Здесь задание несёт сам забег: он умещается в десяток полей, а читать его
 * заново из базы незачем.
 */

const QUEUE_NAME = "admin-notify";
/** Ниже лимита Telegram на группу с запасом: сводка по `/stats` идёт в тот же чат мимо очереди. */
const MESSAGES_PER_MINUTE = 15;
const ENQUEUE_TIMEOUT_MS = 2_000;
const JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: "exponential", delay: 5_000, jitter: 0.5 },
  removeOnComplete: 500,
  removeOnFail: 500,
} as const;

/** Одна карточка разбора на аккаунт за этот срок (review-throttle.ts). */
const REVIEW_WINDOW_SEC = 60 * 60;

type NotifyJob =
  | {
      reportId: string;
      /** задания до записей забегов вида не несли — это стресс-тесты */
      kind?: "bench" | "run";
    }
  | { kind: "review"; run: ReviewCardRun };

export type NotifierBotApi = Pick<TelegramBotApi, "sendPhoto" | "sendMessage">;

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
    private readonly runsHooks: RunsHooks,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(REVIEW_THROTTLE) private readonly throttle: ReviewThrottle,
  ) {}

  /** Карточки отчётов диагностики. */
  get enabled(): boolean {
    const { telegram, notifyReports, ingest } = this.config;
    const anyChat = telegram.chats.stressReports !== null || telegram.chats.runReports !== null;
    return notifyReports && ingest.reportsEnabled && anyChat && telegram.botToken !== "";
  }

  /**
   * Карточки забегов на разбор. Не зависят от `ADMIN_NOTIFY_REPORTS`: это не
   * отчёты диагностики, а очередь антифрода, и выключается она своим адресом.
   */
  get reviewEnabled(): boolean {
    const { telegram, auth } = this.config;
    return auth.enabled && telegram.chats.runReview !== null && telegram.botToken !== "";
  }

  onModuleInit(): void {
    if (this.enabled) this.hooks.onReport("admin-notify", (report) => this.enqueue(report));
    if (this.reviewEnabled) this.runsHooks.onRecorded("admin-notify", (run) => this.enqueueReview(run));
  }

  onApplicationBootstrap(): void {
    if (!this.enabled && !this.reviewEnabled) return;
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
      this.log("warn", "notify_failed", { ...(job === undefined ? {} : jobRef(job.data)), attempts: job?.attemptsMade ?? 0, reason: error.message });
    });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  async enqueue(report: ReceivedReport): Promise<void> {
    if (this.queue === null || this.chatFor(report.kind) === null) return;
    if (report.kind === "run" && report.summary.problems.length === 0) return;
    // jobId от reportId: повтор отчёта не породит второе уведомление. Двоеточие
    // BullMQ в своих идентификаторах не пускает — это разделитель его ключей.
    await withTimeout(
      this.queue.add(
        "report",
        { reportId: report.reportId, kind: report.kind },
        { jobId: `report-${report.reportId}`, ...JOB_OPTIONS },
      ),
      ENQUEUE_TIMEOUT_MS,
      "очередь уведомлений",
    );
  }

  /**
   * Забег на разбор — карточкой, но не чаще раза в час на аккаунт: остальное
   * лежит в `GET /runs/review`. Забег, прошедший проверки, карточки не
   * получает вовсе, как и забег с читами: его пометил сам разработчик.
   */
  async enqueueReview(run: RecordedRun): Promise<void> {
    if (this.queue === null || run.verdict === "ok" || run.cheats) return;
    if (!(await this.throttle.claim(run.accountId, REVIEW_WINDOW_SEC))) {
      this.log("log", "review_throttled", { runId: run.runId, accountId: run.accountId });
      return;
    }
    const card: ReviewCardRun = {
      runId: run.runId,
      accountId: run.accountId,
      difficulty: run.difficulty,
      outcome: run.outcome,
      survivalSec: run.survivalSec,
      level: run.level,
      enemiesKilled: run.enemiesKilled,
      deathCause: run.deathCause,
      verdict: run.verdict,
      reasons: run.reasons,
    };
    await withTimeout(
      this.queue.add("review", { kind: "review", run: card }, { jobId: `review-${run.runId}`, ...JOB_OPTIONS }),
      ENQUEUE_TIMEOUT_MS,
      "очередь уведомлений",
    );
  }

  /** Одна отправка. Вынесена ради тестов: очередь вокруг неё — BullMQ. */
  async process(job: Pick<Job<NotifyJob>, "data">): Promise<void> {
    const { data } = job;
    if (data.kind === "review") {
      const chat = this.config.telegram.chats.runReview;
      if (chat === null) throw new UnrecoverableError(`некуда слать забег ${data.run.runId}`);
      // Имя — на момент отправки: игрок мог сменить его, пока карточка ждала.
      // Аккаунт удалён — карточка всё равно нужна, с одним идентификатором.
      const account = await this.accounts.byId(data.run.accountId);
      await this.send(data, () => this.api.sendMessage(chat, reviewCardText(data.run, account)));
      return;
    }

    const card = await this.cardOf(data);
    // Отчёт удалён сроком хранения или не разбирается нынешней схемой —
    // повтор не поможет.
    if (card === null) throw new UnrecoverableError(`отчёт ${data.reportId} не найден`);

    const chat = this.chatFor(data.kind ?? "bench");
    // Поток отключили, пока задание ждало очереди: слать некуда.
    if (chat === null) throw new UnrecoverableError(`некуда слать отчёт ${data.reportId}`);

    await this.send(data, () => this.api.sendPhoto(chat, card.png, card.caption));
  }

  private async send(data: NotifyJob, deliver: () => Promise<unknown>): Promise<void> {
    try {
      await deliver();
      this.log("log", "notify_sent", jobRef(data));
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

  /** У каждого вида отчёта свой поток: стресс-тесты и забеги не мешаются. */
  private chatFor(kind: "bench" | "run"): ChatTarget | null {
    const { chats } = this.config.telegram;
    return kind === "run" ? chats.runReports : chats.stressReports;
  }

  /** Карточка по отчёту из базы: у записи забега и стресс-теста — своя. */
  private async cardOf(job: Exclude<NotifyJob, { kind: "review" }>): Promise<{ png: Buffer; caption: string } | null> {
    if (job.kind === "run") {
      const stored = await this.reports.findRun(job.reportId);
      if (stored === null) return null;
      const input: RunCardInput = { ...stored, summary: runSummaryOf(stored.payload) };
      return { png: renderRunCardPng(input), caption: runCaption(input) };
    }
    const stored = await this.reports.findBench(job.reportId);
    if (stored === null) return null;
    const input: StressCardInput = { ...stored, summary: benchSummaryOf(stored.payload) };
    return { png: renderStressCardPng(input), caption: stressCaption(input) };
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "admin-notify", event, ...fields }));
  }
}

/** Что писать в лог о задании: ключ отчёта или забега и вид. */
function jobRef(data: NotifyJob): Record<string, string> {
  return data.kind === "review" ? { runId: data.run.runId, kind: "review" } : { reportId: data.reportId, kind: data.kind ?? "bench" };
}
