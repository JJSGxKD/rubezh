import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";

/**
 * Окно, в котором повторный вход — тот же запуск (docs/34-stage3-plan.md,
 * WP6, п. 3). Один запуск Mini App входит не один раз: WebView
 * перезагружается, клиент теряет сессию на старте и входит заново. Без окна
 * каждый такой вход был бы отдельной сессией, и удержание по сессиям врало бы.
 *
 * Окно — ключом в Redis с временем жизни, а не блокировкой строки в базе, как
 * в источнике переноса (docs/13-reuse-from-vpnsibcom.md §6). Другой параметр
 * запуска — другой ключ: запуск по новой ссылке через десять секунд — это
 * новое касание, и терять его нельзя.
 */
export const SESSION_WINDOW_SEC = 30;

export const SESSION_DEDUPE = Symbol("SESSION_DEDUPE");

export interface SessionDedupe {
  /** `true` — запуск новый, его надо записать */
  claim(accountId: string, startParam: string | null): Promise<boolean>;
}

@Injectable()
export class RedisSessionDedupe implements SessionDedupe {
  private readonly logger = new Logger("attribution");

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async claim(accountId: string, startParam: string | null): Promise<boolean> {
    // Параметр — отпечатком: ключ не должен зависеть от того, что прислал клиент.
    const param = createHash("sha256").update(startParam ?? "").digest("hex").slice(0, 16);
    try {
      return (await this.redis.set(`session:recent:${accountId}:${param}`, "1", "EX", SESSION_WINDOW_SEC, "NX")) !== null;
    } catch (error: unknown) {
      // Redis недоступен — записываем: лишняя сессия лучше потерянной.
      this.logger.warn(JSON.stringify({ module: "attribution", event: "dedupe_unavailable", reason: error instanceof Error ? error.message : "unknown" }));
      return true;
    }
  }
}
