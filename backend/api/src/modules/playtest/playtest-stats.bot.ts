import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { PLAYTEST_REDIS } from "./playtest-redis.js";
import { dayKey } from "./playtest-stats.store.js";
import { PlaytestStatsService } from "./playtest-stats.service.js";
import { TelegramApiError, TelegramBotApi, type TelegramUpdate } from "./telegram-bot-api.js";

/**
 * Бот сводки плейтеста: `/stats` в чате администраторов и отчёт раз в сутки
 * (docs/26-stage2-plan.md, WP14).
 *
 * Обновления читаются long polling'ом: плейтест живёт на машине
 * разработчика за туннелем, и публичного адреса для вебхука у неё нет. Когда
 * появится модуль бота на вебхуке (docs/28-diagnostics.md §6.1), команда
 * переедет туда — вебхук и `getUpdates` на одном токене несовместимы, Telegram
 * ответит `409`.
 */

const POLL_TIMEOUT_SEC = 25;
const POLLER_LOCK_TTL_MS = 90_000;
/** Сколько ждать, если читать обновления сейчас не нам: другой процесс или вебхук. */
const STANDBY_MS = 30_000;
const RETRY_MS = 5_000;
const DAILY_TICK_MS = 60_000;
/** Команда из очереди старше этого — не отвечаем: сводка «на тогда» уже не нужна. */
const STALE_COMMAND_SEC = 10 * 60;
/** Не чаще раза в столько секунд на чат: сводка рендерится, спам командой её не должен множить. */
const COMMAND_WINDOW_SEC = 20;

export type BotDecision = { kind: "stats"; chatId: string; place: "admin_chat" | "private" } | { kind: "ignore" };

/**
 * Кому отвечать. Сводка — только счётчики без имён, поэтому в чате
 * администраторов её может запросить любой его участник: доступ задаёт сам
 * чат. В личке — только тот, кто в `ADMIN_TELEGRAM_IDS`. Остальным бот молчит,
 * а не отказывает: существование команды не раскрывается.
 */
export function decideUpdate(update: TelegramUpdate, config: AppConfig, nowMs: number): BotDecision {
  const message = update.message;
  if (message?.text === undefined || message.from === undefined || message.from.is_bot) return { kind: "ignore" };
  if (!/^\/stats(@\w+)?(\s|$)/.test(message.text)) return { kind: "ignore" };
  if (nowMs / 1000 - message.date > STALE_COMMAND_SEC) return { kind: "ignore" };

  const chatId = String(message.chat.id);
  if (chatId === config.playtest.stats.chatId) return { kind: "stats", chatId, place: "admin_chat" };
  const fromId = String(message.from.id);
  if (message.chat.type === "private" && chatId === fromId && config.adminTelegramIds.has(fromId)) {
    return { kind: "stats", chatId, place: "private" };
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
export interface StatsBotLocks {
  /** занять или продлить роль единственного читателя обновлений */
  holdPoller(ownerId: string, ttlMs: number): Promise<boolean>;
  releasePoller(ownerId: string): Promise<void>;
  readOffset(): Promise<number | null>;
  saveOffset(offset: number): Promise<void>;
  /** `true` — отчёт за эти сутки ещё не уходил и теперь закреплён за вызвавшим */
  claimDaily(day: string): Promise<boolean>;
  releaseDaily(day: string): Promise<void>;
  claimCommand(chatId: string, windowSec: number): Promise<boolean>;
}

export const STATS_BOT_LOCKS = Symbol("STATS_BOT_LOCKS");
export const STATS_BOT_API = Symbol("STATS_BOT_API");

/** Продлить лок, только если он всё ещё наш: иначе процесс, проснувшийся после паузы, отнял бы роль у живого. */
const HOLD_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
if current == false then
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
  return 1
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const DAY_LOCK_TTL_SEC = 2 * 24 * 60 * 60;

@Injectable()
export class RedisStatsBotLocks implements StatsBotLocks {
  constructor(@Inject(PLAYTEST_REDIS) private readonly redis: Redis) {}

  async holdPoller(ownerId: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(HOLD_SCRIPT, 1, "pt:bot:poller", ownerId, String(ttlMs))) === 1;
  }

  async releasePoller(ownerId: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, "pt:bot:poller", ownerId);
  }

  async readOffset(): Promise<number | null> {
    const raw = await this.redis.get("pt:bot:offset");
    const offset = raw === null ? Number.NaN : Number(raw);
    return Number.isSafeInteger(offset) ? offset : null;
  }

  async saveOffset(offset: number): Promise<void> {
    await this.redis.set("pt:bot:offset", String(offset), "EX", DAY_LOCK_TTL_SEC);
  }

  async claimDaily(day: string): Promise<boolean> {
    return (await this.redis.set(`pt:bot:daily:${day}`, "1", "EX", DAY_LOCK_TTL_SEC, "NX")) !== null;
  }

  async releaseDaily(day: string): Promise<void> {
    await this.redis.del(`pt:bot:daily:${day}`);
  }

  async claimCommand(chatId: string, windowSec: number): Promise<boolean> {
    return (await this.redis.set(`pt:bot:cmd:${chatId}`, "1", "EX", windowSec, "NX")) !== null;
  }
}

export type StatsBotApi = Pick<TelegramBotApi, "getUpdates" | "sendPhoto" | "sendMessage" | "setMyCommands">;

@Injectable()
export class PlaytestStatsBot implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("playtest-stats");
  private readonly ownerId = randomUUID();
  private readonly stop = new AbortController();
  private polling: Promise<void> | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;
  private conflictLogged = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly stats: PlaytestStatsService,
    @Inject(STATS_BOT_LOCKS) private readonly locks: StatsBotLocks,
    @Inject(STATS_BOT_API) private readonly api: StatsBotApi,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.playtest.stats.enabled) return;
    void this.api
      .setMyCommands([{ command: "stats", description: "Сводка плейтеста" }], this.config.playtest.stats.chatId, this.stop.signal)
      .catch((error: unknown) => this.log("warn", "commands_not_set", { reason: reasonOf(error) }));
    this.polling = this.pollLoop();
    this.dailyTimer = setInterval(() => void this.tickDaily(), DAILY_TICK_MS);
    void this.tickDaily();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop.abort();
    if (this.dailyTimer !== null) clearInterval(this.dailyTimer);
    if (this.polling === null) return;
    await this.polling;
    // Redis закрывается позже, на onApplicationShutdown: лок отпускается явно,
    // чтобы следующий запуск не ждал его истечения. Не отпустился — истечёт сам.
    await this.locks
      .releasePoller(this.ownerId)
      .catch((error: unknown) => this.log("warn", "poller_release_failed", { reason: reasonOf(error) }));
  }

  /** Один проход чтения: вынесен из цикла ради тестов. */
  async pollOnce(): Promise<void> {
    if (!(await this.locks.holdPoller(this.ownerId, POLLER_LOCK_TTL_MS))) {
      await this.wait(STANDBY_MS);
      return;
    }
    const offset = await this.locks.readOffset();
    const { updates, lastUpdateId } = await this.api.getUpdates(offset, POLL_TIMEOUT_SEC, this.stop.signal);
    this.conflictLogged = false;
    // Смещение сохраняется до обработки: упавшая отправка не должна
    // превратиться в бесконечный повтор одной и той же команды.
    if (lastUpdateId !== null) await this.locks.saveOffset(lastUpdateId + 1);
    for (const update of updates) await this.handleUpdate(update);
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const decision = decideUpdate(update, this.config, Date.now());
    if (decision.kind === "ignore") return;
    if (!(await this.locks.claimCommand(decision.chatId, COMMAND_WINDOW_SEC))) return;
    await this.sendReport(decision.chatId, decision.place === "admin_chat" ? "command" : "command_private");
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
    const sent = await this.sendReport(this.config.playtest.stats.chatId, "daily");
    // Сеть или Redis — повторим через минуту. Отказ Telegram (чат не найден,
    // бота выгнали) повтором не лечится: до завтра отчёт не пытается уйти.
    if (sent === "retry") {
      await this.locks
        .releaseDaily(day)
        .catch((error: unknown) => this.log("warn", "daily_release_failed", { day, reason: reasonOf(error) }));
    }
  }

  private async sendReport(chatId: string, trigger: "command" | "command_private" | "daily"): Promise<"sent" | "retry" | "failed"> {
    try {
      const report = await this.stats.report(Date.now());
      await this.api.sendPhoto(chatId, report.png, report.caption, this.stop.signal);
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
          .sendMessage(chatId, "Сводка не собралась, причина — в логе бэкенда", this.stop.signal)
          .catch((notice: unknown) => this.log("warn", "failure_notice_failed", { reason: reasonOf(notice) }));
      }
      return permanent ? "failed" : "retry";
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stop.signal.aborted) {
      try {
        await this.pollOnce();
      } catch (error: unknown) {
        if (this.stop.signal.aborted) return;
        await this.wait(this.backoffFor(error));
      }
    }
  }

  private backoffFor(error: unknown): number {
    if (error instanceof TelegramApiError && error.errorCode === 409) {
      // Второй читатель на том же токене: процесс коллеги или вебхук. Пишем
      // один раз, а не каждые полминуты.
      if (!this.conflictLogged) this.log("warn", "poll_conflict", { reason: error.message });
      this.conflictLogged = true;
      return STANDBY_MS;
    }
    if (error instanceof TelegramApiError && error.retryAfterSec !== null) return error.retryAfterSec * 1000;
    this.log("warn", "poll_failed", { reason: reasonOf(error) });
    return RETRY_MS;
  }

  private async wait(ms: number): Promise<void> {
    try {
      await sleep(ms, undefined, { signal: this.stop.signal });
    } catch (error: unknown) {
      // Прерванное ожидание — это остановка процесса, её и ждали; иное — ошибка.
      if (!this.stop.signal.aborted) throw error;
    }
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "playtest-stats", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

export const statsBotApiProvider = {
  provide: STATS_BOT_API,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): StatsBotApi => new TelegramBotApi(config.playtest.botToken),
};
