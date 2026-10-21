import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";

/**
 * Пауза проверок после «подождите» от площадки (tasks/T-0162, шаг 5): пока
 * ключ жив, ни ночной проход, ни ручная проверка на площадку не ходят —
 * иначе каждая новая проверка продлевала бы ответ 429. Ключ общий для всех
 * реплик, срок ему ставит сама площадка.
 *
 * Redis недоступен — паузы «нет»: игрок не должен упираться в чужой сбой, а
 * следующий ответ площадки поставит паузу заново.
 */

export const PAUSE_KEY = "bot-mention:pause";
/** Дольше часа площадка не просит; больше — ошибка или ловушка, а не причина молчать сутки. */
const MAX_PAUSE_SEC = 3600;
const REDIS_TIMEOUT_MS = 2_000;

@Injectable()
export class BotMentionBackoff {
  private readonly logger = new Logger("bot-mention");

  constructor(@Inject(REDIS) private readonly redis: Pick<Redis, "set" | "pttl">) {}

  /** Сколько ещё ждать, мс; 0 — пауза не стоит. */
  async remainingMs(): Promise<number> {
    try {
      const left = await withTimeout(this.redis.pttl(PAUSE_KEY), REDIS_TIMEOUT_MS, "bot-mention: чтение паузы");
      return left > 0 ? left : 0;
    } catch (error: unknown) {
      this.warn("bot_mention_pause_unreadable", error);
      return 0;
    }
  }

  /** Поставить паузу на `afterSec`; действующая более длинная не укорачивается. */
  async hold(afterSec: number): Promise<void> {
    const ms = Math.min(Math.max(Math.ceil(afterSec), 1), MAX_PAUSE_SEC) * 1000;
    try {
      const left = await withTimeout(this.redis.pttl(PAUSE_KEY), REDIS_TIMEOUT_MS, "bot-mention: чтение паузы");
      if (left >= ms) return;
      await withTimeout(this.redis.set(PAUSE_KEY, "1", "PX", ms), REDIS_TIMEOUT_MS, "bot-mention: запись паузы");
    } catch (error: unknown) {
      this.warn("bot_mention_pause_not_set", error);
    }
  }

  private warn(event: string, error: unknown): void {
    this.logger.warn(JSON.stringify({ module: "bot-mention", event, reason: error instanceof Error ? error.name : "unknown" }));
  }
}
