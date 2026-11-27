import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";

/**
 * Кэш `file_id` картинок бота (docs/35-stage4-plan.md Р156, design/art/meta-v2.md §3.2).
 *
 * Одинаковые данные — одна картинка: ключ — хэш всего, что на ней видно, плюс
 * версия шаблона. После первой отправки площадка отдаёт `file_id`, и дальше та
 * же картинка уходит по нему — без рендера и без загрузки. Смена шаблона —
 * смена версии, иначе старые картинки отдавались бы из кэша.
 */

/** Сколько помнить `file_id`: Telegram хранит файлы бота долго, а шаблон меняется версией. */
export const CARD_CACHE_TTL_SEC = 30 * 24 * 60 * 60;

/** Ключ кэша: самих данных, например имени игрока, в Redis в открытом виде нет — только хэш. */
export function cardCacheKey(version: number, visible: unknown): string {
  return createHash("sha256").update(JSON.stringify([version, visible])).digest("hex");
}

export interface CardFileCache {
  get(key: string): Promise<string | null>;
  set(key: string, fileId: string): Promise<void>;
  delete(key: string): Promise<void>;
}

@Injectable()
export class RedisCardFileCache implements CardFileCache {
  constructor(@Inject(REDIS) protected readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(`bot:card:${key}`);
  }

  async set(key: string, fileId: string): Promise<void> {
    await this.redis.set(`bot:card:${key}`, fileId, "EX", CARD_CACHE_TTL_SEC);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`bot:card:${key}`);
  }
}

export interface CardDeliveryOptions {
  /** площадка больше не знает этот `file_id`: перерисовать и загрузить заново; иная ошибка повторной загрузкой не лечится */
  isStale(error: unknown): boolean;
  /** предупреждения кэша: `cache_unavailable`, `cached_file_rejected`, `cache_delete_failed`, `cache_write_failed` */
  log(event: string, fields: Record<string, unknown>): void;
}

export interface CardJob {
  key: string;
  render(): Buffer | Promise<Buffer>;
  /** отправить картинку: байтами при первой загрузке, `file_id` строкой — при повторе */
  upload(photo: Buffer | string): Promise<{ fileId: string | null }>;
}

export type CardDeliveryResult = { cached: true } | { cached: false; pngBytes: number };

/**
 * Отправка картинки через кэш `file_id`. Площадку и способ отправки знает
 * вызывающий (`upload`, `isStale`): общий слой не импортирует адаптеры.
 */
export class CardDelivery {
  /** рендер одинаковой картинки, начатый другим запросом, не повторяется в этом процессе */
  private readonly rendering = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly cache: CardFileCache,
    private readonly options: CardDeliveryOptions,
  ) {}

  async send(job: CardJob): Promise<CardDeliveryResult> {
    const cached = await this.cache.get(job.key).catch((error: unknown) => {
      this.options.log("cache_unavailable", { reason: reasonOf(error) });
      return null;
    });
    if (cached !== null) {
      try {
        await job.upload(cached);
        return { cached: true };
      } catch (error: unknown) {
        if (!this.options.isStale(error)) throw error;
        this.options.log("cached_file_rejected", { reason: reasonOf(error) });
        await this.cache
          .delete(job.key)
          .catch((cacheError: unknown) => this.options.log("cache_delete_failed", { reason: reasonOf(cacheError) }));
      }
    }

    const png = await this.renderOnce(job);
    const sent = await job.upload(png);
    if (sent.fileId !== null) {
      await this.cache
        .set(job.key, sent.fileId)
        .catch((error: unknown) => this.options.log("cache_write_failed", { reason: reasonOf(error) }));
    }
    return { cached: false, pngBytes: png.length };
  }

  private renderOnce(job: CardJob): Promise<Buffer> {
    const existing = this.rendering.get(job.key);
    if (existing !== undefined) return existing;
    const started = Promise.resolve()
      .then(() => job.render())
      .finally(() => this.rendering.delete(job.key));
    this.rendering.set(job.key, started);
    return started;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
