import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";
import {
  INBOUND_KEY_TTL_SEC,
  INBOUND_PAUSE_MS,
  JOURNAL_CLOCK,
  MAX_METHOD_LENGTH,
  MAX_ROUTE_LENGTH,
  WARN_EVERY_MS,
  bucketOf,
  inboundField,
  minuteKey,
  statusClass,
} from "./journal-rules.js";

/**
 * Счёт входящих запросов в Redis (docs/35-stage4-plan.md Р92, tasks/T-0060).
 *
 * Хеш на минуту, два поля на маршрут и класс статуса: общее число и корзина
 * времени. Оба прибавляются одной транзакцией, а срок жизни ключа — два часа,
 * на случай если перенос в базу долго не идёт. В Redis попадают метод, шаблон
 * маршрута, класс статуса и корзина: ни адреса, ни query, ни игрока.
 *
 * Метод `count` не бросает и не ждёт никого, кроме Redis: вызывающий не
 * дожидается его вовсе (ответ игроку уже ушёл). Redis лёг — минута теряется, а
 * чтобы зависшие команды не копились, счёт замолкает на 10 секунд.
 */
@Injectable()
export class InboundCounter {
  private readonly logger = new Logger("request-journal");
  private readonly now: () => number;
  private pausedUntil = 0;
  private lastWarnAt: number | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "multi">,
    @Optional() @Inject(JOURNAL_CLOCK) now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  async count(method: string, route: string, status: number, durationMs: number, at: Date = new Date()): Promise<void> {
    if (this.now() < this.pausedUntil) return;
    try {
      const key = minuteKey(at);
      const cls = statusClass(status);
      const safeMethod = method.toUpperCase().slice(0, MAX_METHOD_LENGTH);
      // Шаблон маршрута ограничен колонкой: длинный не должен роняться при переносе.
      const safeRoute = route.slice(0, MAX_ROUTE_LENGTH);
      const results = await this.redis
        .multi()
        .hincrby(key, inboundField(safeMethod, cls, "n", safeRoute), 1)
        .hincrby(key, inboundField(safeMethod, cls, bucketOf(durationMs), safeRoute), 1)
        .expire(key, INBOUND_KEY_TTL_SEC)
        .exec();
      // Сбой отдельной команды транзакции не бросает исключение, а лежит в ответе.
      const failed = results?.find(([error]) => error !== null);
      if (failed?.[0]) throw failed[0];
    } catch (error: unknown) {
      this.pausedUntil = this.now() + INBOUND_PAUSE_MS;
      this.warnLimited(error);
    }
  }

  private warnLimited(error: unknown): void {
    const at = this.now();
    if (this.lastWarnAt !== null && at - this.lastWarnAt < WARN_EVERY_MS) return;
    this.lastWarnAt = at;
    this.logger.warn(JSON.stringify({ module: "request-journal", event: "inbound_count_failed", reason: error instanceof Error ? error.message : "unknown" }));
  }
}
