import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { ChatTarget } from "../telegram/chat-target.js";
import type { TelegramBotApi, TelegramUpdate } from "../telegram/telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "../telegram/telegram-bot-api.js";
import { BotRouter, type BotUpdateHandler } from "./bot-router.js";

/**
 * Команды бота в одном месте: меню Telegram и ответ на `/help`
 * (docs/28-diagnostics.md §6.1.2).
 *
 * Список команд собирается с обработчиков — каждый модуль объявляет свои
 * рядом с их реализацией. Кто что видит:
 *
 * - **все** — в любом чате и в меню по умолчанию;
 * - **администраторы** — в личных чатах из `ADMIN_TELEGRAM_IDS` и в чатах
 *   администраторов; в чужом чате команды администратора не показываются и не
 *   отвечают.
 *
 * `/help` нужен именно в чате администраторов: там бот отвечает всем
 * участникам, и половина команд — не для всех.
 */

export type CommandsBotApi = Pick<TelegramBotApi, "sendMessage" | "setMyCommands">;

@Injectable()
export class BotCommands implements BotUpdateHandler, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  readonly name = "help";
  readonly commands = [{ command: "help", description: "Что умеет бот", audience: "everyone" as const }];
  private readonly logger = new Logger("bot");
  private readonly stop = new AbortController();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    @Inject(TELEGRAM_BOT_API) private readonly api: CommandsBotApi,
  ) {}

  onModuleInit(): void {
    if (this.config.telegram.updates !== "off") this.router.register(this);
  }

  /**
   * Меню команд публикуется после старта всех модулей: к этому моменту
   * обработчики уже зарегистрированы, и список полон.
   */
  onApplicationBootstrap(): void {
    if (this.config.telegram.updates === "off") return;
    void this.publish().catch((error: unknown) => this.log("warn", "commands_not_set", { reason: reasonOf(error) }));
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  async publish(): Promise<void> {
    const everyone = this.menuFor(false);
    const admin = this.menuFor(true);
    await this.api.setMyCommands(everyone, null, this.stop.signal);
    for (const chat of this.adminChats()) await this.api.setMyCommands(admin, chat, this.stop.signal);
    for (const adminId of this.config.adminTelegramIds) await this.api.setMyCommands(admin, adminId, this.stop.signal);
    this.log("log", "commands_published", { everyone: everyone.length, admin: admin.length });
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    const message = update.message;
    if (message?.text === undefined || message.from === undefined || message.from.is_bot) return false;
    if (!/^\/help(@\w+)?(\s|$)/.test(message.text)) return false;

    const chatId = String(message.chat.id);
    const forAdmin = this.isAdminChat(chatId) || (message.chat.type === "private" && this.config.adminTelegramIds.has(String(message.from.id)));
    await this.api.sendMessage(
      { chatId, threadId: message.message_thread_id ?? null },
      helpText(this.router.commands(), forAdmin),
      this.stop.signal,
    );
    return true;
  }

  private menuFor(admin: boolean): { command: string; description: string }[] {
    return this.router
      .commands()
      .filter((spec) => admin || spec.audience === "everyone")
      .map(({ command, description }) => ({ command, description }));
  }

  /** Чаты, где команды администратора видны всем участникам. */
  private adminChats(): ChatTarget[] {
    const { chats } = this.config.telegram;
    const targets = [chats.general, chats.stats, chats.stressReports, chats.runReports].filter(
      (chat): chat is ChatTarget => chat !== null,
    );
    return targets.filter((chat, index) => targets.findIndex((other) => other.chatId === chat.chatId) === index);
  }

  private isAdminChat(chatId: string): boolean {
    return this.adminChats().some((chat) => chat.chatId === chatId);
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "bot", event, ...fields }));
  }
}

/** Ответ `/help`: команды для всех и, где уместно, команды администратора. */
export function helpText(commands: readonly { command: string; description: string; audience: "everyone" | "admin" }[], forAdmin: boolean): string {
  const lines = ["Рубеж — бот закрытого теста.", "", "Команды:"];
  for (const spec of commands.filter((spec) => spec.audience === "everyone")) {
    lines.push(`/${spec.command} — ${spec.description}`);
  }
  const adminCommands = commands.filter((spec) => spec.audience === "admin");
  if (forAdmin && adminCommands.length > 0) {
    lines.push("", "Для администраторов:");
    for (const spec of adminCommands) lines.push(`/${spec.command} — ${spec.description}`);
  }
  if (!forAdmin) lines.push("", "Вопрос или баг — напишите команде в чат теста.");
  return lines.join("\n");
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
