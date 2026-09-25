import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { describeDbError } from "../../infra/database.js";
import { REDIS } from "../../infra/redis.js";
import { BotRouter, type BotUpdateHandler } from "../../platforms/telegram/bot-router.js";
import type { InlineButton, TelegramBotApi, TelegramUpdate } from "../../platforms/telegram/telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "../../platforms/telegram/telegram-bot-api.js";
import type { ExportPeriod } from "./export.repository.js";
import { ExportService } from "./export.service.js";
import { RolesService } from "../roles/roles.service.js";

/**
 * Выгрузка через бота (docs/28-diagnostics.md §6.1): администратор нажимает
 * кнопку или пишет `/export` в личке, выбирает период и получает архив
 * документом.
 *
 * Доступ проверяется на **каждом** обновлении, включая нажатия кнопок: кнопку
 * можно подделать, команду — набрать руками. Не-администратору бот не отвечает
 * вовсе — как на любую неизвестную команду, существование выгрузки не
 * раскрывается. Администратору в группе — отказ без данных.
 *
 * Сборка идёт в очереди с параллельностью 1, а не в обработчике: вебхук
 * отвечает сразу, а выгрузка «весь тест» не должна нагружать базу вдвоём.
 */

export const EXPORT_PERIODS = ["day", "week", "since", "all"] as const;
export type ExportPeriodKind = (typeof EXPORT_PERIODS)[number];

const PERIOD_LABELS: Record<ExportPeriodKind, string> = {
  day: "Сутки",
  week: "7 дней",
  since: "С последней выгрузки",
  all: "Весь тест",
};

/** Выгрузка одна на администратора, пока идёт; лок истечёт сам, если процесс упал. */
const LOCK_TTL_SEC = 30 * 60;
/** Выгрузка «весь тест» нагружает базу: не чаще раза в столько. */
const COOLDOWN_SEC = 5 * 60;
const ENQUEUE_TIMEOUT_MS = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExportJob {
  adminId: string;
  chatId: string;
  period: ExportPeriodKind;
  statusMessageId: number;
  requestedAt: number;
}

export interface ExportBotLocks {
  /** `false` — выгрузка этого администратора уже идёт */
  claim(adminId: string): Promise<boolean>;
  release(adminId: string): Promise<void>;
  /** секунд до следующей выгрузки; 0 — можно */
  cooldownLeft(adminId: string): Promise<number>;
  startCooldown(adminId: string): Promise<void>;
}

export const EXPORT_BOT_LOCKS = Symbol("EXPORT_BOT_LOCKS");

@Injectable()
export class RedisExportBotLocks implements ExportBotLocks {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async claim(adminId: string): Promise<boolean> {
    return (await this.redis.set(`bot:export:lock:${adminId}`, "1", "EX", LOCK_TTL_SEC, "NX")) !== null;
  }

  async release(adminId: string): Promise<void> {
    await this.redis.del(`bot:export:lock:${adminId}`);
  }

  async cooldownLeft(adminId: string): Promise<number> {
    return Math.max(0, await this.redis.ttl(`bot:export:cooldown:${adminId}`));
  }

  async startCooldown(adminId: string): Promise<void> {
    await this.redis.set(`bot:export:cooldown:${adminId}`, "1", "EX", COOLDOWN_SEC);
  }
}

export type ExportBotApi = Pick<TelegramBotApi, "sendMessage" | "editMessageText" | "answerCallbackQuery" | "sendDocument" | "setMyCommands">;

/** Куда уходит задание: очередь BullMQ в приложении, прямой вызов в тестах. */
export interface ExportJobQueue {
  add(job: ExportJob): Promise<void>;
}

function isExportPeriod(value: string): value is ExportPeriodKind {
  return (EXPORT_PERIODS as readonly string[]).includes(value);
}

export function periodOf(kind: ExportPeriodKind, now: Date): ExportPeriod | null {
  if (kind === "day") return { from: new Date(now.getTime() - DAY_MS), to: now };
  if (kind === "week") return { from: new Date(now.getTime() - 7 * DAY_MS), to: now };
  if (kind === "all") return { from: null, to: now };
  return null;
}

@Injectable()
export class ExportBotCommand implements BotUpdateHandler, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  readonly name = "export";
  readonly commands = [{ command: "export", description: "Выгрузка данных закрытого теста", audience: "admin" as const }];
  private readonly logger = new Logger("export");
  private queue: Queue<ExportJob> | null = null;
  private worker: Worker<ExportJob> | null = null;
  private connections: Redis[] = [];
  /** подменяется в тестах; в приложении — очередь из onApplicationBootstrap */
  jobs: ExportJobQueue = { add: async (job) => this.enqueue(job) };

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    @Inject(EXPORT_BOT_LOCKS) private readonly locks: ExportBotLocks,
    @Inject(TELEGRAM_BOT_API) private readonly api: ExportBotApi,
    private readonly exports: ExportService,
    private readonly roles: RolesService,
  ) {}

  get enabled(): boolean {
    return this.config.export.botEnabled;
  }

  onModuleInit(): void {
    if (this.enabled) this.router.register(this);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue("export", { connection: producer });
    this.worker = new Worker("export", (job) => this.run(job.data), { connection: consumer, concurrency: 1 });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    if (update.message !== undefined) return this.handleCommand(update.message);
    if (update.callback_query !== undefined) return this.handleCallback(update.callback_query);
    return false;
  }

  private async handleCommand(message: NonNullable<TelegramUpdate["message"]>): Promise<boolean> {
    if (message.text === undefined || !/^\/export(@\w+)?(\s|$)/.test(message.text)) return false;
    // Выгрузка — по праву `data.export`, а не по списку Telegram ID
    // (docs/34-stage3-plan.md, WP2). Список остался аварийным путём внутри
    // ролей: он действует, пока в системе нет ни одного владельца.
    if (message.from === undefined || !(await this.canExport(String(message.from.id)))) {
      // Нет права: молчание, как на неизвестную команду.
      return true;
    }
    const chatId = String(message.chat.id);
    if (message.chat.type !== "private" || chatId !== String(message.from.id)) {
      await this.api.sendMessage(chatId, "Выгрузка — только в личном чате с ботом: здесь её увидели бы все участники.");
      return true;
    }
    await this.sendMenu(chatId);
    return true;
  }

  /** Право на выгрузку у отправителя команды бота. */
  private async canExport(telegramId: string): Promise<boolean> {
    return await this.roles.canByPlatformUser("telegram", telegramId, "data.export");
  }

  private async handleCallback(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<boolean> {
    const data = query.data ?? "";
    if (!data.startsWith("export:")) return false;
    const adminId = String(query.from.id);
    const chat = query.message?.chat;
    const allowed = (await this.canExport(adminId)) && chat !== undefined && chat.type === "private" && String(chat.id) === adminId;
    if (!allowed) {
      // Подделанное нажатие или кнопка из пересланного сообщения: гасим часики
      // у нажавшего и ничего не делаем.
      await this.api.answerCallbackQuery(query.id);
      this.log("warn", "export_denied", { from: adminId });
      return true;
    }

    const choice = data.slice("export:".length);
    if (choice === "menu") {
      await this.api.answerCallbackQuery(query.id);
      await this.sendMenu(adminId);
      return true;
    }
    if (!isExportPeriod(choice)) {
      await this.api.answerCallbackQuery(query.id);
      return true;
    }
    await this.start(query.id, adminId, choice);
    return true;
  }

  private async start(callbackId: string, adminId: string, period: ExportPeriodKind): Promise<void> {
    const wait = await this.locks.cooldownLeft(adminId);
    if (wait > 0) {
      await this.api.answerCallbackQuery(callbackId, `Выгрузка была только что. Следующая — через ${Math.ceil(wait / 60)} мин.`);
      return;
    }
    // Двойное нажатие и нажатия на старые кнопки упираются в этот лок.
    if (!(await this.locks.claim(adminId))) {
      await this.api.answerCallbackQuery(callbackId, "Выгрузка уже готовится");
      return;
    }
    await this.api.answerCallbackQuery(callbackId, "Готовлю выгрузку");
    const statusMessageId = await this.api.sendMessage(adminId, `Готовлю выгрузку: ${PERIOD_LABELS[period].toLowerCase()}…`);
    try {
      await this.jobs.add({ adminId, chatId: adminId, period, statusMessageId, requestedAt: Date.now() });
    } catch (error: unknown) {
      this.log("error", "export_enqueue_failed", { adminId, reason: reasonOf(error) });
      await this.locks.release(adminId);
      await this.api.editMessageText(adminId, statusMessageId, "Не получилось поставить выгрузку в очередь — попробуйте ещё раз.");
    }
  }

  /** Одна выгрузка: сборка, отправка частей, итог в статусе, журнал, локи. */
  async run(job: ExportJob): Promise<void> {
    const now = new Date(job.requestedAt);
    const period = periodOf(job.period, now) ?? (await this.exports.sinceLastExport(job.adminId, now));
    try {
      const artifact = await this.exports.build({ period, source: "bot", requestedBy: job.adminId });
      try {
        const total = artifact.parts.length;
        for (const [index, part] of artifact.parts.entries()) {
          const name = total === 1 ? artifact.fileName : `${artifact.fileName}.${String(index + 1).padStart(3, "0")}`;
          await this.api.sendDocument(job.chatId, part, name, this.caption(artifact, index, total));
        }
        await this.exports.finish(artifact.exportId, {
          status: "sent",
          events: artifact.counts.events,
          reports: artifact.counts.reports,
          sizeBytes: artifact.sizeBytes,
          parts: total,
          error: null,
        });
        await this.api.editMessageText(
          job.chatId,
          job.statusMessageId,
          `Выгрузка готова: ${PERIOD_LABELS[job.period].toLowerCase()}, событий ${artifact.counts.events}, отчётов ${artifact.counts.reports}${total > 1 ? `, частей ${total}` : ""}.`,
        );
        this.log("log", "export_sent", { exportId: artifact.exportId, adminId: job.adminId, period: job.period, parts: total, sizeBytes: artifact.sizeBytes });
        await this.locks.startCooldown(job.adminId);
      } catch (error: unknown) {
        await this.exports.finish(artifact.exportId, {
          status: "failed",
          events: artifact.counts.events,
          reports: artifact.counts.reports,
          sizeBytes: artifact.sizeBytes,
          parts: artifact.parts.length,
          error: reasonOf(error),
        });
        throw error;
      } finally {
        await artifact.cleanup();
      }
    } catch (error: unknown) {
      this.log("error", "export_failed", { adminId: job.adminId, period: job.period, reason: reasonOf(error) });
      await this.api
        .editMessageText(job.chatId, job.statusMessageId, "Выгрузка не собралась — причина в логе бэкенда.")
        .catch((notice: unknown) => this.log("warn", "failure_notice_failed", { reason: reasonOf(notice) }));
    } finally {
      await this.locks.release(job.adminId).catch((error: unknown) => this.log("warn", "lock_release_failed", { reason: reasonOf(error) }));
    }
  }

  private caption(artifact: Awaited<ReturnType<ExportService["build"]>>, index: number, total: number): string {
    const from = artifact.period.from?.toISOString().slice(0, 16).replace("T", " ") ?? "начало теста";
    const to = artifact.period.to.toISOString().slice(0, 16).replace("T", " ");
    return [
      `Выгрузка ${artifact.exportId.slice(0, 8)}${total > 1 ? ` · часть ${index + 1} из ${total}` : ""}`,
      `Период: ${from} — ${to} UTC`,
      `Событий ${artifact.counts.events}, отчётов ${artifact.counts.reports}, забегов ${artifact.counts.runs}`,
      `Сборки: ${artifact.appVersions.join(", ") || "—"}`,
      `Размер: ${(artifact.sizeBytes / 1024 / 1024).toFixed(1)} МБ`,
      total > 1 ? "Склейка: copy /b файл.zip.001+файл.zip.002 файл.zip или cat файл.zip.* > файл.zip" : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private async sendMenu(chatId: string): Promise<void> {
    const keyboard: InlineButton[][] = [
      [
        { text: PERIOD_LABELS.day, callback_data: "export:day" },
        { text: PERIOD_LABELS.week, callback_data: "export:week" },
      ],
      [{ text: PERIOD_LABELS.since, callback_data: "export:since" }],
      [{ text: PERIOD_LABELS.all, callback_data: "export:all" }],
    ];
    await this.api.sendMessage(
      chatId,
      "Выгрузка данных закрытого теста. За какой период? Telegram ID в архиве заменены псевдонимами.",
      undefined,
      { keyboard },
    );
  }

  private async enqueue(job: ExportJob): Promise<void> {
    if (this.queue === null) throw new Error("очередь выгрузок не запущена");
    await withTimeout(
      this.queue.add("export", job, { attempts: 1, removeOnComplete: 100, removeOnFail: 100 }),
      ENQUEUE_TIMEOUT_MS,
      "очередь выгрузок",
    );
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "export", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return describeDbError(error);
}
