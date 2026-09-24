import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { TelegramApiError, type TelegramBotApi, type TelegramUpdate } from "../telegram/telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "../telegram/telegram-bot-api.js";
import { BotRouter } from "./bot-router.js";

/**
 * Чтение обновлений long polling'ом — для машины разработчика, у которой нет
 * публичного адреса для вебхука (docs/28-diagnostics.md §6.1.3).
 *
 * Читатель на токен один: вебхук и `getUpdates` несовместимы, а второй
 * `getUpdates` получает от Telegram `409`. Роль читателя держит лок в Redis,
 * смещение живёт там же — перезапуск процесса не повторяет старые команды.
 */

const POLL_TIMEOUT_SEC = 25;
const POLLER_LOCK_TTL_MS = 90_000;
/** Сколько ждать, если читать обновления сейчас не нам: другой процесс или вебхук. */
const STANDBY_MS = 30_000;
const RETRY_MS = 5_000;
const OFFSET_TTL_SEC = 2 * 24 * 60 * 60;

export interface BotPollerLocks {
  /** занять или продлить роль единственного читателя обновлений */
  holdPoller(ownerId: string, ttlMs: number): Promise<boolean>;
  releasePoller(ownerId: string): Promise<void>;
  readOffset(): Promise<number | null>;
  saveOffset(offset: number): Promise<void>;
}

export const BOT_POLLER_LOCKS = Symbol("BOT_POLLER_LOCKS");

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

@Injectable()
export class RedisBotPollerLocks implements BotPollerLocks {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async holdPoller(ownerId: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(HOLD_SCRIPT, 1, "bot:poller", ownerId, String(ttlMs))) === 1;
  }

  async releasePoller(ownerId: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, "bot:poller", ownerId);
  }

  async readOffset(): Promise<number | null> {
    const raw = await this.redis.get("bot:offset");
    const offset = raw === null ? Number.NaN : Number(raw);
    return Number.isSafeInteger(offset) ? offset : null;
  }

  async saveOffset(offset: number): Promise<void> {
    await this.redis.set("bot:offset", String(offset), "EX", OFFSET_TTL_SEC);
  }
}

export type PollerBotApi = Pick<TelegramBotApi, "getUpdates">;

@Injectable()
export class BotPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("bot");
  private readonly ownerId = randomUUID();
  private readonly stop = new AbortController();
  private polling: Promise<void> | null = null;
  private conflictLogged = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    @Inject(BOT_POLLER_LOCKS) private readonly locks: BotPollerLocks,
    @Inject(TELEGRAM_BOT_API) private readonly api: PollerBotApi,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.telegram.updates !== "polling") return;
    this.polling = this.pollLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop.abort();
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
    for (const update of urgentFirst(updates)) await this.router.dispatch(update);
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
    this.logger[level](JSON.stringify({ module: "bot", event, ...fields }));
  }
}

/**
 * Предварительную проверку оплаты Telegram ждёт десять секунд, а карточка
 * приветствия рисуется секунды: в одной пачке с командами проверка идёт
 * первой, иначе оплата сорвалась бы из-за чужого `/start`. Остальной порядок
 * сохраняется.
 */
export function urgentFirst(updates: readonly TelegramUpdate[]): TelegramUpdate[] {
  const urgent = updates.filter((update) => update.pre_checkout_query !== undefined);
  return urgent.length === 0 ? [...updates] : [...urgent, ...updates.filter((update) => update.pre_checkout_query === undefined)];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
