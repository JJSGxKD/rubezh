import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { BotRouter, type BotUpdateHandler } from "../../platforms/telegram/bot-router.js";
import { sameChat, type ChatTarget } from "../../platforms/telegram/chat-target.js";
import { TelegramApiError, type TelegramBotApi, type TelegramUpdate } from "../../platforms/telegram/telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "../../platforms/telegram/telegram-bot-api.js";
import { dayKey } from "./playtest-stats.store.js";
import { PlaytestStatsService } from "./playtest-stats.service.js";

/**
 * Сводка плейтеста в Telegram: `/stats` в чате администраторов и отчёт раз в
 * сутки (docs/26-stage2-plan.md, WP14). Обновления приносит модуль бота —
 * здесь только решение, кому отвечать, и доставка картинки.
 */

const DAILY_TICK_MS = 60_000;
/** Команда из очереди старше этого — не отвечаем: сводка «на тогда» уже не нужна. */
const STALE_COMMAND_SEC = 10 * 60;
/** Не чаще раза в столько секунд на чат: сводка рендерится, спам командой её не должен множить. */
const COMMAND_WINDOW_SEC = 20;
const DAY_LOCK_TTL_SEC = 2 * 24 * 60 * 60;

export type StatsDecision = { kind: "stats"; target: ChatTarget; place: "admin_chat" | "private" } | { kind: "ignore" };

/**
 * Кому отвечать. Сводка — только счётчики без имён, поэтому в чате
 * администраторов её может запросить любой его участник: доступ задаёт сам
 * чат. В личке — только тот, кто в `ADMIN_TELEGRAM_IDS`. Остальным бот молчит,
 * а не отказывает: существование команды не раскрывается.
 */
export function decideUpdate(update: TelegramUpdate, config: AppConfig, nowMs: number): StatsDecision {
  const message = update.message;
  if (message?.text === undefined || message.from === undefined || message.from.is_bot) return { kind: "ignore" };
  if (!/^\/stats(@\w+)?(\s|$)/.test(message.text)) return { kind: "ignore" };
  if (nowMs / 1000 - message.date > STALE_COMMAND_SEC) return { kind: "ignore" };

  const chatId = String(message.chat.id);
  // Отвечаем туда же, откуда спросили: в супергруппе с темами — в ту же тему,
  // а не в общую ленту.
  const target: ChatTarget = { chatId, threadId: message.message_thread_id ?? null };
  const stats = config.telegram.chats.stats;
  if (stats !== null && sameChat(stats, chatId)) return { kind: "stats", target, place: "admin_chat" };
  const fromId = String(message.from.id);
  if (message.chat.type === "private" && chatId === fromId && config.adminTelegramIds.has(fromId)) {
    return { kind: "stats", target, place: "private" };
  }
  return { kind: "ignore" };
}

/** Сутки, за которые пора отправить отчёт, или `null`, если время ещё не пришло. */
export function dailyReportDay(nowMs: number, offsetMin: number, dailyAtMin: number | null): string | null {
  if (dailyAtMin === null) return null;
  const local = new Date(nowMs + offsetMin * 60_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return minute >= dailyAtMin ? dayKey(nowMs, offsetMin) : null;
}

/** Координация между процессами бэкенда с общим Redis. */
export interface StatsReporterLocks {
  /** `true` — отчёт за эти сутки ещё не уходил и теперь закреплён за вызвавшим */
  claimDaily(day: string): Promise<boolean>;
  releaseDaily(day: string): Promise<void>;
  claimCommand(chatId: string, windowSec: number): Promise<boolean>;
}

export const STATS_REPORTER_LOCKS = Symbol("STATS_REPORTER_LOCKS");

@Injectable()
export class RedisStatsReporterLocks implements StatsReporterLocks {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async claimDaily(day: string): Promise<boolean> {
    return (await this.redis.set(`pt:report:daily:${day}`, "1", "EX", DAY_LOCK_TTL_SEC, "NX")) !== null;
  }

  async releaseDaily(day: string): Promise<void> {
    await this.redis.del(`pt:report:daily:${day}`);
  }

  async claimCommand(chatId: string, windowSec: number): Promise<boolean> {
    return (await this.redis.set(`pt:report:cmd:${chatId}`, "1", "EX", windowSec, "NX")) !== null;
  }
}

export type StatsReporterApi = Pick<TelegramBotApi, "sendPhoto" | "sendMessage" | "setMyCommands">;

@Injectable()
export class PlaytestStatsReporter implements BotUpdateHandler, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  readonly name = "playtest-stats";
  readonly commands = [{ command: "stats", description: "Сводка плейтеста", audience: "admin" as const }];
  private readonly logger = new Logger("playtest-stats");
  private readonly stop = new AbortController();
  private dailyTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly stats: PlaytestStatsService,
    private readonly router: BotRouter,
    @Inject(STATS_REPORTER_LOCKS) private readonly locks: StatsReporterLocks,
    @Inject(TELEGRAM_BOT_API) private readonly api: StatsReporterApi,
  ) {}

  onModuleInit(): void {
    if (this.config.playtest.stats.enabled) this.router.register(this);
  }

  onApplicationBootstrap(): void {
    if (!this.config.playtest.stats.enabled) return;
    this.dailyTimer = setInterval(() => void this.tickDaily(), DAILY_TICK_MS);
    void this.tickDaily();
  }

  onModuleDestroy(): void {
    this.stop.abort();
    if (this.dailyTimer !== null) clearInterval(this.dailyTimer);
  }

  async handle(update: TelegramUpdate): Promise<boolean> {
    const decision = decideUpdate(update, this.config, Date.now());
    if (decision.kind === "ignore") return false;
    if (!(await this.locks.claimCommand(decision.target.chatId, COMMAND_WINDOW_SEC))) return true;
    await this.sendReport(decision.target, decision.place === "admin_chat" ? "command" : "command_private");
    return true;
  }

  async tickDaily(): Promise<void> {
    const day = dailyReportDay(Date.now(), this.config.playtest.statsUtcOffsetMin, this.config.playtest.stats.dailyAtMin);
    if (day === null) return;
    try {
      if (!(await this.locks.claimDaily(day))) return;
    } catch (error: unknown) {
      this.log("warn", "daily_lock_failed", { reason: reasonOf(error) });
      return;
    }
    const sent = await this.sendReport(this.config.telegram.chats.stats ?? { chatId: "", threadId: null }, "daily");
    // Сеть или Redis — повторим через минуту. Отказ Telegram (чат не найден,
    // бота выгнали) повтором не лечится: до завтра отчёт не пытается уйти.
    if (sent === "retry") {
      await this.locks
        .releaseDaily(day)
        .catch((error: unknown) => this.log("warn", "daily_release_failed", { day, reason: reasonOf(error) }));
    }
  }

  private async sendReport(target: ChatTarget, trigger: "command" | "command_private" | "daily"): Promise<"sent" | "retry" | "failed"> {
    if (target.chatId === "") return "failed";
    try {
      const report = await this.stats.report(Date.now());
      await this.api.sendPhoto(target, report.png, report.caption, this.stop.signal);
      this.log("log", "report_sent", {
        trigger,
        players: report.summary.players.seen,
        runsTotal: report.summary.runsTotal,
        pngBytes: report.png.length,
      });
      return "sent";
    } catch (error: unknown) {
      this.log("error", "report_failed", { trigger, reason: reasonOf(error) });
      const permanent = error instanceof TelegramApiError && error.errorCode >= 400 && error.errorCode < 500 && error.errorCode !== 429;
      if (trigger !== "daily") {
        await this.api
          .sendMessage(target, "Сводка не собралась, причина — в логе бэкенда", this.stop.signal)
          .catch((notice: unknown) => this.log("warn", "failure_notice_failed", { reason: reasonOf(notice) }));
      }
      return permanent ? "failed" : "retry";
    }
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "playtest-stats", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
