import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";

/**
 * Кеш картинок шеринга (docs/24-attribution-and-sharing.md §7.4): рендер —
 * самая дорогая операция потока, а одну карточку спрашивают мессенджеры и
 * люди многократно. Ключ — хэш параметров (`share-card.ts`).
 *
 * Redis недоступен — карточка рисуется заново: картинка важнее кеша, а
 * промах стоит лишь времени рендера.
 */

export const SHARE_CARD_CACHE = Symbol("SHARE_CARD_CACHE");

export interface ShareCardCache {
  get(key: string): Promise<Buffer | null>;
  set(key: string, png: Buffer): Promise<void>;
}

/** Неделя: забег не меняется, а сменённое имя даст новый ключ само. */
const TTL_SEC = 7 * 86_400;

@Injectable()
export class RedisShareCardCache implements ShareCardCache {
  private readonly logger = new Logger("links");

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async get(key: string): Promise<Buffer | null> {
    try {
      return await this.redis.getBuffer(cacheKey(key));
    } catch (error: unknown) {
      this.warn("share_card_cache_read_failed", error);
      return null;
    }
  }

  async set(key: string, png: Buffer): Promise<void> {
    try {
      await this.redis.set(cacheKey(key), png, "EX", TTL_SEC);
    } catch (error: unknown) {
      this.warn("share_card_cache_write_failed", error);
    }
  }

  private warn(event: string, error: unknown): void {
    this.logger.warn(JSON.stringify({ module: "links", event, reason: error instanceof Error ? error.message : "unknown" }));
  }
}

function cacheKey(key: string): string {
  return `share:card:${key}`;
}
