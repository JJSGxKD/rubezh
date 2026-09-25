import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { BotRouter, type BotUpdateHandler } from "../../platforms/telegram/bot-router.js";
import type { TelegramBotApi, TelegramUpdate } from "../../platforms/telegram/telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "../../platforms/telegram/telegram-bot-api.js";
import { FEEDBACK_REPOSITORY, type FeedbackRepository, type StoredFeedback } from "./feedback.repository.js";

/**
 * `/feedback` — выгрузка отзывов администратору в личный чат
 * (docs/29-admin-panel.md §6).
 *
 * Без очереди и блокировок, в отличие от `/export`: отзывов десятки, а не
 * гигабайты, запрос — один SELECT с потолком. Файл CSV с BOM: его открывают
 * таблицей, а не читают в Telegram.
 */

/** Сколько отзывов уходит в выгрузку: больше в таблице всё равно не читают. */
const EXPORT_LIMIT = 500;

export type FeedbackBotApi = Pick<TelegramBotApi, "sendMessage" | "sendDocument">;

@Injectable()
export class FeedbackBotCommand implements BotUpdateHandler, OnModuleInit {
  readonly name = "feedback";
  readonly commands = [{ command: "feedback", description: "Отзывы игроков файлом", audience: "admin" as const }];
  private readonly logger = new Logger("feedback");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    @Inject(TELEGRAM_BOT_API) private readonly api: FeedbackBotApi,
    @Inject(FEEDBACK_REPOSITORY) private readonly repository: FeedbackRepository,
  ) {}

  get enabled(): boolean {
    return this.config.telegram.updates !== "off" && this.config.databaseUrl !== "";
  }

  onModuleInit(): void {
    if (this.enabled) this.router.register(this);
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    const message = update.message;
    if (message?.text === undefined || !/^\/feedback(@\w+)?(\s|$)/.test(message.text)) return false;
    if (message.from === undefined || !this.config.adminTelegramIds.has(String(message.from.id))) {
      // Не-администратор: молчание, как на неизвестную команду.
      return true;
    }

    const chatId = String(message.chat.id);
    if (message.chat.type !== "private" || chatId !== String(message.from.id)) {
      await this.api.sendMessage(chatId, "Отзывы — только в личном чате с ботом: здесь их увидели бы все участники.");
      return true;
    }

    const feedback = await this.repository.recent(EXPORT_LIMIT);
    if (feedback.length === 0) {
      await this.api.sendMessage(chatId, "Отзывов пока нет.");
      return true;
    }

    const directory = await mkdtemp(join(tmpdir(), "rubezh-feedback-"));
    const file = join(directory, fileName(new Date()));
    try {
      await writeFile(file, csvOf(feedback), "utf8");
      await this.api.sendDocument(chatId, file, fileName(new Date()), caption(feedback));
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({ module: "feedback", event: "export_failed", reason: error instanceof Error ? error.message : "unknown" }),
      );
      await this.api.sendMessage(chatId, "Не удалось отправить файл отзывов. Причина — в логе бэкенда.");
    } finally {
      // Временный каталог убирается всегда: отзывы — это тексты игроков.
      await rm(directory, { recursive: true, force: true });
    }
    return true;
  }
}

function fileName(now: Date): string {
  return `feedback-${now.toISOString().slice(0, 10)}.csv`;
}

function caption(feedback: readonly StoredFeedback[]): string {
  const withText = feedback.filter((item) => item.text !== "").length;
  return `Отзывы: ${String(feedback.length)}, из них с текстом ${String(withText)}. Новые сверху.`;
}

/**
 * CSV с точкой с запятой и BOM: так его открывает Excel с русской локалью, не
 * разваливая строки по столбцам и не превращая кириллицу в кракозябры.
 */
export function csvOf(feedback: readonly StoredFeedback[]): string {
  const header = ["Когда", "Платформа", "Версия", "Забегов", "Telegram ID", "Ответы", "Текст"];
  const rows = feedback.map((item) => [
    item.createdAt.toISOString(),
    item.platform,
    item.appVersion,
    String(item.runs),
    item.platformUserId ?? "",
    Object.entries(item.answers)
      .map(([question, option]) => `${question}=${option}`)
      .join(" "),
    item.text,
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(cell).join(";")).join("\r\n")}\r\n`;
}

/** Экранирование CSV: кавычки удваиваются, ячейка с разделителем берётся в кавычки. */
function cell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[";\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}
