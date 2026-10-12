import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "../../platforms/telegram/telegram-bot-api.js";
import { NotifyTargets } from "../settings/notify-targets.js";

/**
 * Тревога о всплеске ответов 5xx (tasks/T-0035): API жив и отвечает на
 * внешнюю проверку, но часть запросов падает с 500 или 503 — сломался модуль,
 * отвалилась очередь, кончилось место. Лёгкий мониторинг без новых сервисов:
 * счётчик в самом API и в Redis.
 *
 * **Одно сообщение на всплеск.** Тревога — в момент, когда счётчик
 * календарной минуты дошёл до порога, а затем тишина: без неё всплеск давал бы
 * сообщение в минуту. Тишину ставит `SET NX EX`, так что две реплики не пришлют
 * его дважды.
 *
 * **Без Redis — по памяти процесса.** Без него не работают и токены продления,
 * так что 5xx посыплются сами; при нескольких репликах порог мягче, но
 * сообщение о сбое важнее точности.
 *
 * `record` никогда не бросает: ответ игроку уже ушёл, а счётчик
 * второстепенен.
 */

/** Столько ответов 5xx за календарную минуту на все реплики — уже не случайность. */
const THRESHOLD = 20;
/** Пока всплеск не кончился, команде не нужно по сообщению в минуту. */
const QUIET_SEC = 15 * 60;
const SEND_TIMEOUT_MS = 5_000;
/** Счётчик минуты живёт две минуты: минута закрылась, а запоздавшая реплика ещё дописывает. */
const COUNTER_TTL_SEC = 120;
const MINUTE_MS = 60_000;

export type ServerErrorAlarmApi = Pick<TelegramBotApi, "sendMessage">;
type AlarmRedis = Pick<Redis, "multi" | "set" | "hgetall">;

/** Ответы минуты по кодам. */
type Counts = Map<string, number>;

@Injectable()
export class ServerErrorAlarm {
  private readonly logger = new Logger("admin-notify");
  /** счёт и тишина в памяти — на случай, когда Redis недоступен */
  private readonly memory = new Map<number, { counts: Counts; total: number }>();
  private quietUntilMs = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly targets: NotifyTargets,
    @Inject(REDIS) private readonly redis: AlarmRedis,
    @Inject(TELEGRAM_BOT_API) private readonly api: ServerErrorAlarmApi,
  ) {}

  async record(status: number, nowMs = Date.now()): Promise<void> {
    try {
      const minute = Math.floor(nowMs / MINUTE_MS);
      let counts: Counts | null;
      try {
        counts = await this.countInRedis(minute, status);
      } catch (error: unknown) {
        this.logger.warn(JSON.stringify({ module: "admin-notify", event: "server_error_alarm_memory", reason: reasonOf(error) }));
        counts = this.countInMemory(minute, status, nowMs);
      }
      if (counts !== null) await this.send(minute, counts);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "server_error_alarm_failed", reason: reasonOf(error) }));
    }
  }

  /** Коды минуты, если именно этот ответ дошёл до порога и тишины нет; иначе `null`. */
  private async countInRedis(minute: number, status: number): Promise<Counts | null> {
    const key = `alarm:5xx:${String(minute)}`;
    const results = await this.redis.multi().hincrby(key, String(status), 1).hincrby(key, "total", 1).expire(key, COUNTER_TTL_SEC).exec();
    const total = totalOf(results);
    if (total !== THRESHOLD) return null;
    if ((await this.redis.set("alarm:5xx:quiet", "1", "EX", QUIET_SEC, "NX")) === null) return null;
    const hash = await this.redis.hgetall(key);
    const counts: Counts = new Map();
    for (const [field, value] of Object.entries(hash)) if (field !== "total") counts.set(field, Number(value));
    return counts;
  }

  private countInMemory(minute: number, status: number, nowMs: number): Counts | null {
    // Старые минуты — вон при каждом вызове: память не растёт.
    for (const old of this.memory.keys()) if (old < minute - 1) this.memory.delete(old);
    const entry = this.memory.get(minute) ?? { counts: new Map<string, number>(), total: 0 };
    this.memory.set(minute, entry);
    entry.total += 1;
    entry.counts.set(String(status), (entry.counts.get(String(status)) ?? 0) + 1);
    if (entry.total !== THRESHOLD || nowMs < this.quietUntilMs) return null;
    this.quietUntilMs = nowMs + QUIET_SEC * 1000;
    return new Map(entry.counts);
  }

  private async send(minute: number, counts: Counts): Promise<void> {
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const chat = this.targets.chats().ops;
    if (chat === null || this.config.telegram.botToken === "") {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "server_error_alarm", total, sent: false, reason: chat === null ? "no_chat" : "no_token" }));
      return;
    }
    try {
      await this.api.sendMessage(chat, alarmText(minute, counts, total), AbortSignal.timeout(SEND_TIMEOUT_MS));
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "server_error_alarm", total, sent: true }));
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "server_error_alarm", total, sent: false, reason: reasonOf(error) }));
    }
  }
}

/** Число, минута и коды по количеству — без путей, текстов ошибок и данных игроков. */
export function alarmText(minute: number, counts: Counts, total: number): string {
  const codes = [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([code, count]) => `${code} × ${String(count)}`)
    .join(", ");
  return [
    `🔥 Всплеск ошибок API: ${String(total)} ответов 5xx за минуту с ${utcClock(minute)} UTC`,
    `Коды: ${codes}`,
    "Следующее сообщение — не раньше чем через 15 минут. Логи: docker compose logs --tail 200 api",
  ].join("\n");
}

/** ЧЧ:ММ по UTC: сервер и логи в UTC, команда ищет всплеск в них. */
function utcClock(minute: number): string {
  return new Date(minute * MINUTE_MS).toISOString().slice(11, 16);
}

/** Второй результат `multi` — счётчик «всего»; ошибка команды — ошибка всего счёта, чтобы сработала память. */
function totalOf(results: [Error | null, unknown][] | null): number {
  const total = results?.[1];
  if (total === undefined || total[0] !== null) throw total?.[0] ?? new Error("пустой ответ multi");
  return Number(total[1]);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
