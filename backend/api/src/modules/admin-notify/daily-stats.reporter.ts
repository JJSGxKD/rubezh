import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { sameChat, type ChatTarget } from "../../platforms/ports/chat-target.js";
import { BotRouter, type BotUpdateHandler } from "../../platforms/telegram/bot-router.js";
import { TELEGRAM_BOT_API, TelegramApiError, type TelegramBotApi, type TelegramUpdate } from "../../platforms/telegram/telegram-bot-api.js";
import { RolesService } from "../roles/roles.service.js";
import { NotifyTargets } from "../settings/notify-targets.js";
import { dayWindow, dueDay, previousDay, statsText, teamDay } from "./daily-stats.js";
import { DAILY_STATS_REPOSITORY, type DailyStatsRepository } from "./daily-stats.repository.js";

/**
 * Ежедневная статистика в чат команды (docs/35-stage4-plan.md §3.18, Р55):
 * в 00:10 по Москве — за прошедшие сутки с разницей к предыдущим, по `/stats`
 * — за сегодня с полуночи. Заменила сводку плейтеста: цифры — из базы, а не
 * из счётчиков рядом с ней.
 *
 * Реплик может быть несколько, а отчёт за сутки — один: сутки закрывает та,
 * что первой заняла отметку в Redis. Сетевой сбой отпускает отметку — отчёт
 * уйдёт в следующую минуту; отказ Telegram (чат не найден, бота выгнали) —
 * нет: повтор его не вылечит, а засыпать лог каждую минуту незачем.
 */

const TICK_MS = 60_000;
const SEND_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 20_000;
/** Отметка суток живёт дольше самих суток: догонять старые отчёты незачем. */
const CLAIM_TTL_SEC = 3 * 86_400;
/** `/stats` из одного чата — не чаще раза в 20 секунд: это запросы к базе. */
const COMMAND_WINDOW_SEC = 20;
/** Команда из очереди, пролежавшая дольше, — уже не вопрос, а эхо. */
const STALE_COMMAND_SEC = 120;

export const DAILY_STATS_LOCKS = Symbol("DAILY_STATS_LOCKS");

export interface DailyStatsLocks {
  claimDay(day: string): Promise<boolean>;
  releaseDay(day: string): Promise<void>;
  claimCommand(chatId: string): Promise<boolean>;
}

@Injectable()
export class RedisDailyStatsLocks implements DailyStatsLocks {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async claimDay(day: string): Promise<boolean> {
    return (await this.redis.set(`stats:daily:${day}`, "1", "EX", CLAIM_TTL_SEC, "NX")) !== null;
  }

  async releaseDay(day: string): Promise<void> {
    await this.redis.del(`stats:daily:${day}`);
  }

  async claimCommand(chatId: string): Promise<boolean> {
    return (await this.redis.set(`stats:cmd:${chatId}`, "1", "EX", COMMAND_WINDOW_SEC, "NX")) !== null;
  }
}

export type DailyStatsApi = Pick<TelegramBotApi, "sendMessage">;

export type TickResult = "sent" | "already" | "no_chat" | "failed";

@Injectable()
export class DailyStatsReporter implements BotUpdateHandler, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  readonly name = "stats";
  readonly commands = [{ command: "stats", description: "Статистика за сегодня", audience: "admin" as const }];
  private readonly logger = new Logger("admin-notify");
  private readonly stop = new AbortController();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly targets: NotifyTargets,
    private readonly router: BotRouter,
    @Inject(DAILY_STATS_REPOSITORY) private readonly stats: DailyStatsRepository,
    @Inject(DAILY_STATS_LOCKS) private readonly locks: DailyStatsLocks,
    @Inject(TELEGRAM_BOT_API) private readonly api: DailyStatsApi,
    private readonly roles: RolesService,
  ) {}

  /** Без базы нечего считать, без токена — некому отправить; чат проверяется на каждом проходе. */
  private get possible(): boolean {
    return this.config.databaseUrl !== "" && this.config.telegram.botToken !== "";
  }

  onModuleInit(): void {
    if (this.possible && this.config.telegram.updates !== "off") this.router.register(this);
  }

  onApplicationBootstrap(): void {
    if (!this.possible) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.stop.abort();
  }

  /** Один проход: пора ли отчёт за прошедшие сутки и не отправила ли его другая реплика. */
  async tick(nowMs = Date.now()): Promise<TickResult> {
    const chat = this.targets.chats().stats;
    if (chat === null) return "no_chat";
    const day = dueDay(nowMs);
    if (!(await this.locks.claimDay(day))) return "already";
    try {
      const text = await this.dayReport(day);
      await withTimeout(this.api.sendMessage(chat, text, this.stop.signal), SEND_TIMEOUT_MS, "отчёт статистики");
      this.log("log", "daily_stats_sent", { day });
      return "sent";
    } catch (error: unknown) {
      const refused = error instanceof TelegramApiError && error.errorCode >= 400;
      if (!refused) await this.locks.releaseDay(day);
      this.log("warn", "daily_stats_failed", { day, retry: !refused, reason: error instanceof Error ? error.message : "unknown" });
      return "failed";
    }
  }

  /** Отчёт за сутки с разницей к предыдущим. */
  async dayReport(day: string): Promise<string> {
    const [today, before] = await withTimeout(
      Promise.all([this.stats.day(dayWindow(day)), this.stats.day(dayWindow(previousDay(day)))]),
      READ_TIMEOUT_MS,
      "статистика суток",
    );
    return statsText(day, today, before);
  }

  /**
   * `/stats` — за сегодня с полуночи. В чате статистики отвечает любому
   * участнику: это и есть чат команды. В личке — тому, кому аналитика
   * открыта ролью.
   */
  async handle(update: TelegramUpdate): Promise<boolean> {
    const message = update.message;
    if (message?.text === undefined || message.from === undefined || message.from.is_bot) return false;
    if (!/^\/stats(@\w+)?(\s|$)/.test(message.text)) return false;
    if (Date.now() / 1000 - message.date > STALE_COMMAND_SEC) return true;

    const chatId = String(message.chat.id);
    const target: ChatTarget = { chatId, threadId: message.message_thread_id ?? null };
    const stats = this.targets.chats().stats;
    const inStatsChat = stats !== null && sameChat(stats, chatId);
    const privateAllowed =
      message.chat.type === "private" && chatId === String(message.from.id) && (await this.roles.canByPlatformUser("telegram", chatId, "analytics.gameplay.view"));
    // Чужой чат и чужая личка — молчание, как на неизвестную команду.
    if (!inStatsChat && !privateAllowed) return true;
    if (!(await this.locks.claimCommand(chatId))) return true;

    const day = teamDay(Date.now());
    const today = await withTimeout(this.stats.day(dayWindow(day)), READ_TIMEOUT_MS, "статистика суток");
    await this.api.sendMessage(target, statsText(day, today, null), this.stop.signal);
    return true;
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "admin-notify", event, ...fields }));
  }
}
