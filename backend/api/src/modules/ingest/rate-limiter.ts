import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";

/**
 * Лимит частоты для приёмников (docs/28-diagnostics.md §5.3): фиксированное
 * окно, счётчик и срок жизни ставятся одним скриптом — два запроса в одну
 * миллисекунду не пробьют лимит, как пробил бы read-modify-write из кода.
 *
 * Redis недоступен — приём продолжается с лимитом в памяти процесса и
 * предупреждением в лог: потерять отчёты тестеров хуже, чем на время сбоя
 * ослабить лимит. При N репликах фактический лимит в N раз мягче; от этого
 * состояния корректность не зависит (docs/15-engineering-standards.md §8).
 */

const CONSUME_SCRIPT = `
local count = redis.call("INCRBY", KEYS[1], ARGV[1])
if count == tonumber(ARGV[1]) then
  redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return count
`;

/** Как часто напоминать в лог, что лимит держится в памяти. */
const FALLBACK_LOG_INTERVAL_MS = 60_000;
/** Потолок ключей в памяти: без него сбой Redis под нагрузкой съел бы память процесса. */
const MEMORY_MAX_KEYS = 50_000;

export interface RateLimit {
  /** что ограничиваем: `events:ip`, `reports:install` — часть ключа */
  scope: string;
  limit: number;
  windowSec: number;
}

@Injectable()
export class RateLimiter {
  private readonly logger = new Logger("ingest");
  private readonly memory = new Map<string, { count: number; resetAt: number }>();
  private lastFallbackLogAt = 0;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Учесть `cost` обращений. `false` — лимит исчерпан в этом окне; превышение
   * тоже учитывается, чтобы долбящий клиент не получал новое окно раньше срока.
   */
  async consume(rule: RateLimit, key: string, cost = 1, nowMs = Date.now()): Promise<boolean> {
    const windowIndex = Math.floor(nowMs / 1000 / rule.windowSec);
    const redisKey = `rl:${rule.scope}:${key}:${windowIndex}`;
    try {
      const count = Number(await this.redis.eval(CONSUME_SCRIPT, 1, redisKey, String(cost), String(rule.windowSec)));
      return count <= rule.limit;
    } catch (error: unknown) {
      this.warnFallback(error, nowMs);
      return this.consumeInMemory(redisKey, rule, cost, nowMs);
    }
  }

  private consumeInMemory(key: string, rule: RateLimit, cost: number, nowMs: number): boolean {
    const entry = this.memory.get(key);
    if (entry === undefined || entry.resetAt <= nowMs) {
      if (this.memory.size >= MEMORY_MAX_KEYS) this.evictExpired(nowMs);
      this.memory.set(key, { count: cost, resetAt: nowMs + rule.windowSec * 1000 });
      return cost <= rule.limit;
    }
    entry.count += cost;
    return entry.count <= rule.limit;
  }

  private evictExpired(nowMs: number): void {
    for (const [key, entry] of this.memory) if (entry.resetAt <= nowMs) this.memory.delete(key);
    // Всё ещё полно — окна живые, но это уже не лимит, а утечка: начинаем заново.
    if (this.memory.size >= MEMORY_MAX_KEYS) this.memory.clear();
  }

  private warnFallback(error: unknown, nowMs: number): void {
    if (nowMs - this.lastFallbackLogAt < FALLBACK_LOG_INTERVAL_MS) return;
    this.lastFallbackLogAt = nowMs;
    this.logger.warn(
      JSON.stringify({
        module: "ingest",
        event: "rate_limit_in_memory",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}
